#!/usr/bin/env python3
"""Generate images via gpt-image-2.5 (text-to-image).

Reads a JSON spec: [{id, prompt, size, background, out, model}]
"""
import base64
import json
import os
import sys
import time
import urllib.error
import urllib.request

CRED = os.path.expanduser("~/.hermes/credentials/openai-image.json")
API_KEY = json.load(open(CRED))["api_key"]
ENDPOINT = "https://api.openai.com/v1/images/generations"
DEFAULT_MODEL = "gpt-image-2.5-flare"


def generate(item):
    body = {
        "model": item.get("model", DEFAULT_MODEL),
        "prompt": item["prompt"],
        "n": 1,
        "size": item.get("size", "1024x1024"),
        "output_format": "png",
    }
    if item.get("background"):
        body["background"] = item["background"]

    req = urllib.request.Request(
        ENDPOINT,
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {API_KEY}"},
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
        "model": body["model"],
        "secs": round(time.time() - started, 1),
        "tokens": data.get("usage", {}).get("output_tokens"),
    }


if __name__ == "__main__":
    spec_path = sys.argv[1]
    concurrency = int(sys.argv[2]) if len(sys.argv) > 2 else 3
    spec = json.load(open(spec_path))
    todo = [it for it in spec if not (os.path.exists(it["out"]) and not it.get("force"))]
    print(f"{len(spec)} items, {len(todo)} to generate", flush=True)

    from concurrent.futures import ThreadPoolExecutor

    failed = 0
    with ThreadPoolExecutor(max_workers=concurrency) as pool:
        for res in pool.map(generate, todo):
            if not res["ok"]:
                failed += 1
            print(json.dumps(res), flush=True)
    print(f"\nDONE failed={failed}", flush=True)
