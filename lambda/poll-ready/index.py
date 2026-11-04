"""
poll-ready Lambda — K8s Deployment readyReplicas 확인

Step Functions Wait loop에서 호출:
  - readyReplicas >= 1 → {"ready": true}
  - 아직 준비 안 됨    → {"ready": false, "readyReplicas": 0, "message": "..."}

Event payload:
  {
    "deployment": "qwen35-27b",
    "namespace": "vllm",          // optional, default "vllm"
    "clusterName": "genai-gw"  // optional, overrides env var
  }
"""
import json
import os
import urllib.request
import urllib.error
import ssl
import base64
import tempfile

import boto3
import botocore.auth
from botocore.awsrequest import AWSRequest

REGION = os.environ.get("EKS_REGION", "ap-northeast-2")
DEFAULT_CLUSTER = os.environ.get("EKS_CLUSTER_NAME", "genai-gw")
DEFAULT_NS = "vllm"

TOKEN_EXPIRY_SECS = 14 * 60  # 14 minutes


def _get_k8s_token(cluster_name: str = DEFAULT_CLUSTER) -> str:
    """boto3 STS presigned URL → K8s bearer token (no aws CLI needed)."""
    session = boto3.Session()
    credentials = session.get_credentials().get_frozen_credentials()
    url = f"https://sts.{REGION}.amazonaws.com/?Action=GetCallerIdentity&Version=2011-06-15"
    request = AWSRequest(method="GET", url=url, headers={"x-k8s-aws-id": cluster_name})
    signer = botocore.auth.SigV4QueryAuth(credentials, "sts", REGION, expires=TOKEN_EXPIRY_SECS)
    signer.add_auth(request)
    return "k8s-aws-v1." + base64.urlsafe_b64encode(request.url.encode()).decode().rstrip("=")


def _get_k8s_endpoint(cluster_name: str) -> tuple[str, bytes]:
    eks = boto3.client("eks", region_name=REGION)
    resp = eks.describe_cluster(name=cluster_name)
    cluster = resp["cluster"]
    endpoint = cluster["endpoint"]
    ca_bytes = base64.b64decode(cluster["certificateAuthority"]["data"])
    return endpoint, ca_bytes


def _k8s_get(path: str, endpoint: str, ca_bytes: bytes, token: str) -> dict:
    url = f"{endpoint}{path}"
    with tempfile.NamedTemporaryFile(suffix=".crt", delete=False) as f:
        f.write(ca_bytes)
        ca_path = f.name
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    ctx.load_verify_locations(cafile=ca_path)
    req = urllib.request.Request(url, headers={
        "Authorization": f"Bearer {token}",
        "Accept": "application/json",
    })
    with urllib.request.urlopen(req, context=ctx, timeout=30) as resp:
        return json.loads(resp.read())


def handler(event: dict, context) -> dict:
    deployment = event["deployment"]
    namespace = event.get("namespace", DEFAULT_NS)
    cluster_name = event.get("clusterName", DEFAULT_CLUSTER)

    try:
        endpoint, ca_bytes = _get_k8s_endpoint(cluster_name)
        token = _get_k8s_token(cluster_name)
    except Exception as e:
        return {"ready": False, "readyReplicas": 0, "message": f"k8s auth failed: {e}"}

    try:
        path = f"/apis/apps/v1/namespaces/{namespace}/deployments/{deployment}"
        dep = _k8s_get(path, endpoint, ca_bytes, token)
        ready = dep.get("status", {}).get("readyReplicas", 0) or 0
        desired = dep.get("spec", {}).get("replicas", 1)
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return {"ready": False, "readyReplicas": 0, "message": f"deployment {deployment} not found"}
        return {"ready": False, "readyReplicas": 0, "message": f"k8s error: {e}"}
    except Exception as e:
        return {"ready": False, "readyReplicas": 0, "message": str(e)}

    return {
        "ready": ready >= 1,
        "readyReplicas": ready,
        "desiredReplicas": desired,
        "deployment": deployment,
        "message": f"{ready}/{desired} ready",
    }
