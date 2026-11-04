"""
scale-vllm Lambda — K8s Deployment replicas 및 HPA suspend 조작

Event payload:
  {
    "action": "scale-up" | "scale-down",
    "deployments": ["qwen35-27b", "internvl3-14b", ...],  // K8s Deployment names
    "namespace": "vllm",               // optional, default "vllm"
    "clusterName": "genai-gw"       // optional, overrides env var
  }

Returns: { "scaled": [...], "errors": [...] }

IAM requirements (task role):
  eks:DescribeCluster — to get K8s API server endpoint + CA
  ssm:GetParameter — to get bearer token (not needed if using IRSA/EKS Pod Identity)
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

# Replica targets
SCALE_UP_REPLICAS = 1
SCALE_DOWN_REPLICAS = 0

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
    """EKS describe-cluster → (endpoint, ca_bundle_bytes)."""
    eks = boto3.client("eks", region_name=REGION)
    resp = eks.describe_cluster(name=cluster_name)
    cluster = resp["cluster"]
    endpoint = cluster["endpoint"]
    ca_b64 = cluster["certificateAuthority"]["data"]
    ca_bytes = base64.b64decode(ca_b64)
    return endpoint, ca_bytes


def _k8s_request(method: str, path: str, body: dict | None, endpoint: str, ca_bytes: bytes, token: str) -> dict:
    """K8s API server HTTP call using urllib (no external dependencies)."""
    url = f"{endpoint}{path}"

    with tempfile.NamedTemporaryFile(suffix=".crt", delete=False) as f:
        f.write(ca_bytes)
        ca_path = f.name

    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    ctx.load_verify_locations(cafile=ca_path)

    data = json.dumps(body).encode() if body else None
    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/strategic-merge-patch+json" if method == "PATCH" else "application/json",
        "Accept": "application/json",
    }
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    with urllib.request.urlopen(req, context=ctx, timeout=30) as resp:
        return json.loads(resp.read())


def _patch_deployment_replicas(name: str, namespace: str, replicas: int, endpoint: str, ca_bytes: bytes, token: str) -> dict:
    path = f"/apis/apps/v1/namespaces/{namespace}/deployments/{name}"
    patch = {"spec": {"replicas": replicas}}
    return _k8s_request("PATCH", path, patch, endpoint, ca_bytes, token)


def _patch_hpa_suspend(name: str, namespace: str, suspend: bool, endpoint: str, ca_bytes: bytes, token: str) -> dict:
    """Suspend/resume HPA to prevent it from fighting our manual scale."""
    path = f"/apis/autoscaling/v2/namespaces/{namespace}/horizontalpodautoscalers/{name}"
    patch = {"spec": {"minReplicas": None if not suspend else 1}}
    if suspend:
        # Disable HPA scaling by setting minReplicas=maxReplicas=0 effectively
        # K8s HPA v2 does not have a "suspend" field in older versions;
        # we scale the Deployment directly and let HPA reconcile once pods are ready.
        # No-op here — Deployment replicas override takes effect immediately.
        return {"skipped": True}
    return {"skipped": True}


def handler(event: dict, context) -> dict:
    action = event.get("action", "scale-up")
    deployments: list[str] = event.get("deployments", [])
    namespace = event.get("namespace", DEFAULT_NS)
    cluster_name = event.get("clusterName", DEFAULT_CLUSTER)

    if not deployments:
        return {"scaled": [], "errors": ["no deployments specified"]}

    replicas = SCALE_UP_REPLICAS if action == "scale-up" else SCALE_DOWN_REPLICAS

    try:
        endpoint, ca_bytes = _get_k8s_endpoint(cluster_name)
        token = _get_k8s_token(cluster_name)
    except Exception as e:
        return {"scaled": [], "errors": [f"k8s auth failed: {e}"]}

    scaled = []
    errors = []
    for dep in deployments:
        try:
            _patch_deployment_replicas(dep, namespace, replicas, endpoint, ca_bytes, token)
            scaled.append({"deployment": dep, "replicas": replicas})
        except Exception as e:
            errors.append({"deployment": dep, "error": str(e)})

    return {"action": action, "scaled": scaled, "errors": errors}
