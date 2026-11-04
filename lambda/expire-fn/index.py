"""
expire-fn — warm-up reservation 만료 처리

Called by EventBridge Scheduler at reservation expireAt time.

Event payload:
  { "alias": "coding", "reservationId": "uuid" }

Logic:
  1. Delete the reservation item from DynamoDB
  2. Count remaining active reservations for this alias
  3. If 0 → start CooldownMachine SFN for this alias only
  4. If > 0 → no-op (other reservations still active)
"""
import json
import os
import time
import boto3
from boto3.dynamodb.conditions import Key

REGION           = os.environ.get("EKS_REGION", "ap-northeast-2")
TABLE_NAME       = os.environ["RESERVATIONS_TABLE"]
COOLDOWN_SFN     = os.environ["COOLDOWN_SFN_ARN"]
CLUSTER_NAME     = os.environ["EKS_CLUSTER_NAME"]
K8S_NAMESPACE    = os.environ.get("K8S_NAMESPACE", "vllm")
ALIAS_TO_SERVING = json.loads(os.environ.get("ALIAS_TO_SERVING", "{}"))

ddb   = boto3.resource("dynamodb", region_name=REGION)
table = ddb.Table(TABLE_NAME)
sfn   = boto3.client("stepfunctions", region_name=REGION)


def _delete_reservation(alias: str, rid: str):
    table.delete_item(Key={"alias": alias, "reservationId": rid})


def _active_count(alias: str) -> int:
    now = int(time.time())
    resp = table.query(
        KeyConditionExpression=Key("alias").eq(alias),
        FilterExpression="expireAt > :now",
        ExpressionAttributeValues={":now": now},
        ConsistentRead=True,  # prevent race: DDB replica lag can hide concurrent reserve-fn writes
    )
    return resp["Count"]


def _start_cooldown(alias: str):
    # K8s Deployment name == servingName (not alias). Convert alias → servingName.
    # e.g., alias="audio" → servingName="phi4-multimodal"
    deployment = ALIAS_TO_SERVING.get(alias, alias)
    sfn.start_execution(
        stateMachineArn=COOLDOWN_SFN,
        input=json.dumps({
            "source": "reservation-expire",
            "deployments": [deployment],
            "namespace": K8S_NAMESPACE,
            "clusterName": CLUSTER_NAME,
        }),
    )


def handler(event: dict, context) -> dict:
    alias = event["alias"]
    rid   = event["reservationId"]

    _delete_reservation(alias, rid)

    remaining = _active_count(alias)
    if remaining == 0:
        _start_cooldown(alias)
        return {"alias": alias, "action": "cooldown-started", "remaining": 0}

    return {"alias": alias, "action": "no-op", "remaining": remaining}
