#!/usr/bin/env python3
"""Generate an alternate POSE of an existing character, for walk animation.

Uses the images/edits endpoint with the shipped sprite as the reference, so the
character keeps its identity, costume and scale while the limbs move.
"""
import base64
import json
import os
import sys
import time
import urllib.error
import urllib.request
import uuid

CRED = os.path.expanduser("~/.hermes/credentials/openai-image.json")
API_KEY = json.load(open(CRED))["api_key"]
ENDPOINT = "https://api.openai.com/v1/images/edits"
MODEL = "gpt-image-2.5-flare"


def multipart(fields, files):
    boundary = uuid.uuid4().hex
    body = b""
    for name, value in fields.items():
        body += f"--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"\r\n\r\n{value}\r\n".encode()
    for name, path in files.items():
        with open(path, "rb") as fh:
            data = fh.read()
        body += (
            f"--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"; "
            f"filename=\"{os.path.basename(path)}\"\r\nContent-Type: image/png\r\n\r\n"
        ).encode()
        body += data + b"\r\n"
    body += f"--{boundary}--\r\n".encode()
    return boundary, body


def pose(item):
    fields = {
        "model": item.get("model", MODEL),
        "prompt": item["prompt"],
        "size": item.get("size", "1024x1024"),
        "background": "transparent",
        "output_format": "png",
    }
    boundary, body = multipart(fields, {"image": item["ref"]})
    req = urllib.request.Request(
        ENDPOINT,
        data=body,
        headers={
            "Content-Type": f"multipart/form-data; boundary={boundary}",
            "Authorization": f"Bearer {API_KEY}",
        },
    )
    started = time.time()
    try:
        with urllib.request.urlopen(req, timeout=300) as resp:
            data = json.load(resp)
    except urllib.error.HTTPError as e:
        return {"id": item["id"], "ok": False, "error": f"HTTP {e.code}: {e.read().decode()[:300]}"}
    except Exception as e:  # noqa: BLE001
        return {"id": item["id"], "ok": False, "error": f"{type(e).__name__}: {e}"}

    b64 = data.get("data", [{}])[0].get("b64_json")
    if not b64:
        return {"id": item["id"], "ok": False, "error": json.dumps(data)[:200]}
    out = item["out"]
    os.makedirs(os.path.dirname(out), exist_ok=True)
    with open(out, "wb") as f:
        f.write(base64.b64decode(b64))
    return {
        "id": item["id"],
        "ok": True,
        "out": out,
        "bytes": os.path.getsize(out),
        "secs": round(time.time() - started, 1),
        "usage": data.get("usage", {}).get("output_tokens"),
    }


if __name__ == "__main__":
    spec = json.load(open(sys.argv[1]))
    for item in spec:
        if os.path.exists(item["out"]) and not item.get("force"):
            print(json.dumps({"id": item["id"], "ok": True, "skipped": True}), flush=True)
            continue
        print(json.dumps(pose(item)), flush=True)
