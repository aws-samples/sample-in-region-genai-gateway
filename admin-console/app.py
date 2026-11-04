"""
In-Region GenAI Gateway — Admin Console
Internal ALB (admin.genai-gw.internal)

Pages:
  GET  /          — dashboard: reservations + deployment status
  POST /cooldown  — admin password auth → force scale-down (alias or all)
"""
import json
import os
import time
import datetime
import urllib.request
import urllib.error
import ssl
import base64
import subprocess
import tempfile

import boto3
import httpx
from fastapi import FastAPI, Request, Form
from fastapi.responses import HTMLResponse
from fastapi.templating import Jinja2Templates
from boto3.dynamodb.conditions import Key

REGION             = os.environ.get("EKS_REGION", "ap-northeast-2")
TABLE_NAME         = os.environ["RESERVATIONS_TABLE"]
COOLDOWN_SFN       = os.environ["COOLDOWN_SFN_ARN"]
ADMIN_SECRET       = os.environ["ADMIN_SECRET_ARN"]
CLUSTER_NAME       = os.environ["EKS_CLUSTER_NAME"]
K8S_NAMESPACE      = os.environ.get("K8S_NAMESPACE", "vllm")
ALL_ALIASES        = json.loads(os.environ["ALL_ALIASES"])
DAILY_WARMUP_RULE  = os.environ["DAILY_WARMUP_RULE"]

ddb    = boto3.resource("dynamodb", region_name=REGION)
table  = ddb.Table(TABLE_NAME)
sfn    = boto3.client("stepfunctions", region_name=REGION)
sm     = boto3.client("secretsmanager", region_name=REGION)
events = boto3.client("events", region_name=REGION)

app = FastAPI(title="GenAI Gateway Admin")
templates = Jinja2Templates(directory="/app/templates")


# ── K8s helpers ───────────────────────────────────────────────────────────────

def _get_k8s_token() -> str:
    result = subprocess.run(
        ["aws", "eks", "get-token", "--cluster-name", CLUSTER_NAME, "--region", REGION],
        capture_output=True, text=True, check=True,
    )
    return json.loads(result.stdout)["status"]["token"]


def _get_k8s_endpoint() -> tuple[str, bytes]:
    eks = boto3.client("eks", region_name=REGION)
    resp = eks.describe_cluster(name=CLUSTER_NAME)
    c = resp["cluster"]
    return c["endpoint"], base64.b64decode(c["certificateAuthority"]["data"])


def _k8s_get(path: str) -> dict:
    endpoint, ca_bytes = _get_k8s_endpoint()
    token = _get_k8s_token()
    with tempfile.NamedTemporaryFile(suffix=".crt", delete=False) as f:
        f.write(ca_bytes)
        ca_path = f.name
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    ctx.load_verify_locations(cafile=ca_path)
    url = f"{endpoint}{path}"
    req = urllib.request.Request(url, headers={
        "Authorization": f"Bearer {token}", "Accept": "application/json",
    })
    with urllib.request.urlopen(req, context=ctx, timeout=10) as resp:
        return json.loads(resp.read())


def _get_deployment_status() -> list[dict]:
    """Return [{alias, servingName, ready, desired}] for all tracked aliases."""
    results = []
    try:
        data = _k8s_get(f"/apis/apps/v1/namespaces/{K8S_NAMESPACE}/deployments")
        dep_map = {d["metadata"]["name"]: d for d in data.get("items", [])}
        for alias in ALL_ALIASES:
            # alias == servingName is not always true; lookup by app label
            dep = dep_map.get(alias)
            if dep:
                ready = dep.get("status", {}).get("readyReplicas", 0) or 0
                desired = dep.get("spec", {}).get("replicas", 0) or 0
            else:
                ready, desired = 0, 0
            results.append({"alias": alias, "ready": ready, "desired": desired})
    except Exception as e:
        for alias in ALL_ALIASES:
            results.append({"alias": alias, "ready": "?", "desired": "?", "error": str(e)})
    return results


# ── DynamoDB helpers ──────────────────────────────────────────────────────────

def _get_active_reservations() -> list[dict]:
    now = int(time.time())
    results = []
    for alias in ALL_ALIASES:
        resp = table.query(
            KeyConditionExpression=Key("alias").eq(alias),
            FilterExpression="expireAt > :now",
            ExpressionAttributeValues={":now": now},
        )
        for item in resp.get("Items", []):
            expire_dt = datetime.datetime.fromtimestamp(
                int(item["expireAt"]), tz=datetime.timezone.utc
            ).astimezone(datetime.timezone(datetime.timedelta(hours=9)))
            remaining_m = max(0, (int(item["expireAt"]) - now) // 60)
            results.append({
                "alias":         item["alias"],
                "reservationId": item["reservationId"][:8],
                "requester":     item.get("requester", "unknown"),
                "expireKST":     expire_dt.strftime("%H:%M KST"),
                "remainingMin":  remaining_m,
            })
    results.sort(key=lambda x: x["alias"])
    return results


# ── EventBridge helpers ───────────────────────────────────────────────────────

def _get_daily_schedule() -> dict:
    """Return {enabled, scheduleExpression, description} for the daily warm-up rule."""
    try:
        resp = events.describe_rule(Name=DAILY_WARMUP_RULE)
        return {
            "enabled":            resp.get("State") == "ENABLED",
            "state":              resp.get("State", "UNKNOWN"),
            "scheduleExpression": resp.get("ScheduleExpression", ""),
            "description":        resp.get("Description", ""),
        }
    except Exception as e:
        return {"enabled": False, "state": "ERROR", "scheduleExpression": "",
                "description": "", "error": str(e)}


def _set_daily_schedule(enable: bool):
    if enable:
        events.enable_rule(Name=DAILY_WARMUP_RULE)
    else:
        events.disable_rule(Name=DAILY_WARMUP_RULE)


# ── Auth helper ───────────────────────────────────────────────────────────────

def _check_admin_password(password: str) -> bool:
    try:
        resp = sm.get_secret_value(SecretId=ADMIN_SECRET)
        secret = json.loads(resp["SecretString"])
        return password == secret.get("password", "")
    except Exception:
        return False


# ── Routes ────────────────────────────────────────────────────────────────────

@app.get("/health/liveliness")
async def health():
    return {"status": "ok"}


@app.get("/", response_class=HTMLResponse)
async def dashboard(request: Request, message: str = ""):
    deployments   = _get_deployment_status()
    reservations  = _get_active_reservations()
    schedule      = _get_daily_schedule()
    return templates.TemplateResponse("index.html", {
        "request":      request,
        "deployments":  deployments,
        "reservations": reservations,
        "schedule":     schedule,
        "all_aliases":  ALL_ALIASES,
        "message":      message,
    })


@app.post("/schedule/toggle", response_class=HTMLResponse)
async def toggle_schedule(
    request: Request,
    action: str = Form(...),   # "enable" | "disable"
    password: str = Form(...),
):
    if not _check_admin_password(password):
        message = "❌ 인증 실패: 비밀번호가 틀렸습니다."
    elif action not in ("enable", "disable"):
        message = f"❌ 잘못된 요청: action={action}"
    else:
        try:
            _set_daily_schedule(action == "enable")
            verb = "활성화" if action == "enable" else "비활성화"
            message = f"✅ 일일 warm-up 스케줄 {verb} 완료 ({DAILY_WARMUP_RULE})"
        except Exception as e:
            message = f"❌ EventBridge 호출 실패: {e}"

    return templates.TemplateResponse("index.html", {
        "request":      request,
        "deployments":  _get_deployment_status(),
        "reservations": _get_active_reservations(),
        "schedule":     _get_daily_schedule(),
        "all_aliases":  ALL_ALIASES,
        "message":      message,
    })


@app.post("/cooldown", response_class=HTMLResponse)
async def force_cooldown(
    request: Request,
    alias: str = Form(...),
    password: str = Form(...),
):
    if not _check_admin_password(password):
        return templates.TemplateResponse("index.html", {
            "request":      request,
            "deployments":  _get_deployment_status(),
            "reservations": _get_active_reservations(),
            "all_aliases":  ALL_ALIASES,
            "message":      "❌ 인증 실패: 비밀번호가 틀렸습니다.",
        })

    # Determine targets
    targets = ALL_ALIASES if alias == "all" else [alias]

    # Delete all active reservations for these aliases
    now = int(time.time())
    for a in targets:
        resp = table.query(
            KeyConditionExpression=Key("alias").eq(a),
            FilterExpression="expireAt > :now",
            ExpressionAttributeValues={":now": now},
        )
        for item in resp.get("Items", []):
            table.delete_item(Key={"alias": a, "reservationId": item["reservationId"]})

    # Force scale-down via SFN
    sfn.start_execution(
        stateMachineArn=COOLDOWN_SFN,
        input=json.dumps({
            "source": "admin-force-cooldown",
            "deployments": targets,
            "namespace": K8S_NAMESPACE,
            "clusterName": CLUSTER_NAME,
        }),
    )

    return templates.TemplateResponse("index.html", {
        "request":      request,
        "deployments":  _get_deployment_status(),
        "reservations": _get_active_reservations(),
        "all_aliases":  ALL_ALIASES,
        "message":      f"✅ 강제 Cool-down 시작: {', '.join(targets)}",
    })
