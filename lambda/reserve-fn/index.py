"""
reserve-fn — warm-up reservation 생성

Event payload:
  {
    "alias": "coding" | "math" | "all",   // "all" expands to every model alias
    "durationSecs": 3600,                  // default 3600
    "requester": "andrew"                  // optional label
  }

Returns:
  { "reservationId": "...", "alias": [...], "expireAt": epoch, "scaledUp": [...] }

Side effects:
  1. DynamoDB: write reservation item per alias (TTL = expireAt)
  2. EventBridge Scheduler: create one-time schedule to call expire-fn at expireAt
  3. SFN WarmupMachine: start if alias transitions 0 → 1 active reservations
"""
import json
import os
import time
import uuid
import boto3
from boto3.dynamodb.conditions import Key

REGION             = os.environ.get("EKS_REGION", "ap-northeast-2")
TABLE_NAME         = os.environ["RESERVATIONS_TABLE"]
WARMUP_SFN         = os.environ["WARMUP_SFN_ARN"]
SCALE_SFN          = os.environ["COOLDOWN_SFN_ARN"]   # not used here, kept for symmetry
EXPIRE_FN_ARN      = os.environ["EXPIRE_FN_ARN"]
SCHEDULER_ROLE_ARN = os.environ["SCHEDULER_ROLE_ARN"]
ALL_ALIASES        = json.loads(os.environ["ALL_ALIASES"])  # ["coding","ocr","video",...]
# {"coding": "qwen35-27b", "math": "gemma4-31b", ...}
ALIAS_TO_SERVING   = json.loads(os.environ.get("ALIAS_TO_SERVING", "{}"))
CLUSTER_NAME       = os.environ["EKS_CLUSTER_NAME"]
K8S_NAMESPACE      = os.environ.get("K8S_NAMESPACE", "vllm")

ddb   = boto3.resource("dynamodb", region_name=REGION)
table = ddb.Table(TABLE_NAME)
sfn   = boto3.client("stepfunctions", region_name=REGION)
sched = boto3.client("scheduler", region_name=REGION)


def _active_count(alias: str) -> int:
    now = int(time.time())
    resp = table.query(
        KeyConditionExpression=Key("alias").eq(alias),
        FilterExpression="expireAt > :now",
        ExpressionAttributeValues={":now": now},
    )
    return resp["Count"]


def _write_reservation(alias: str, rid: str, expire_at: int, requester: str, duration_secs: int):
    table.put_item(Item={
        "alias":        alias,
        "reservationId": rid,
        "expireAt":     expire_at,
        "requester":    requester,
        "durationSecs": duration_secs,
        "createdAt":    int(time.time()),
    })


def _create_eb_schedule(alias: str, rid: str, expire_at: int):
    """Create a one-time EventBridge Scheduler that fires expire-fn at expireAt."""
    import datetime
    dt = datetime.datetime.fromtimestamp(expire_at, tz=datetime.timezone.utc)
    schedule_time = dt.strftime("%Y-%m-%dT%H:%M:%S")

    sched.create_schedule(
        Name=f"genai-gw-expire-{alias}-{rid[:8]}",
        GroupName="genai-gw-reservations",
        ScheduleExpression=f"at({schedule_time})",
        FlexibleTimeWindow={"Mode": "OFF"},
        Target={
            "Arn": EXPIRE_FN_ARN,
            "RoleArn": SCHEDULER_ROLE_ARN,
            "Input": json.dumps({
                "alias": alias,
                "reservationId": rid,
            }),
        },
        ActionAfterCompletion="DELETE",
    )


def _start_warmup(aliases: list[str]):
    # Map alias → K8s Deployment name (servingName); fall back to alias if not found
    deployments = [ALIAS_TO_SERVING.get(a, a) for a in aliases]
    sfn.start_execution(
        stateMachineArn=WARMUP_SFN,
        input=json.dumps({
            "source": "reservation",
            "deployments": deployments,
            "namespace": K8S_NAMESPACE,
            "clusterName": CLUSTER_NAME,
        }),
    )


def handler(event: dict, context) -> dict:
    alias_input  = event.get("alias", "all")
    duration     = int(event.get("durationSecs", 3600))
    requester    = event.get("requester", "unknown")

    # Expand "all"
    if alias_input == "all":
        aliases = list(ALL_ALIASES)
    elif isinstance(alias_input, list):
        aliases = alias_input
    else:
        aliases = [a.strip() for a in alias_input.split(",")]

    expire_at = int(time.time()) + duration
    rid = str(uuid.uuid4())

    scaled_up = []
    for alias in aliases:
        before = _active_count(alias)
        _write_reservation(alias, rid, expire_at, requester, duration)
        _create_eb_schedule(alias, rid, expire_at)
        # 0 → 1: trigger scale-up for this alias
        if before == 0:
            scaled_up.append(alias)

    if scaled_up:
        _start_warmup(scaled_up)

    return {
        "reservationId": rid,
        "aliases": aliases,
        "expireAt": expire_at,
        "durationSecs": duration,
        "scaledUp": scaled_up,
        "requester": requester,
    }
