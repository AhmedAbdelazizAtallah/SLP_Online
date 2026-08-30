import json
import urllib.error
import urllib.request

BASE = "http://127.0.0.1:8131"


def request(path, payload=None):
    body = None if payload is None else json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        BASE + path,
        data=body,
        headers={"Content-Type": "application/json"} if body else {},
    )
    try:
        with urllib.request.urlopen(req, timeout=5) as response:
            return response.status, json.load(response)
    except urllib.error.HTTPError as exc:
        return exc.code, json.load(exc)


status, ice = request("/api/ice-servers")
assert status == 200
assert ice["iceServers"] and ice["iceServers"][0]["urls"]
assert all("credential" not in entry for entry in ice["iceServers"]), ice
print("PASS no TURN credential is exposed without environment configuration")

status, _ = request("/predict", {"language": "invalid", "sequence": [0] * 63})
assert status == 422, status
print("PASS unsupported prediction language rejected")

status, result = request("/predict", {"language": "en", "sequence": [[0] * 21]})
assert status == 400 and "expected" in result["detail"], (status, result)
print("PASS malformed landmark shape rejected")

status, result = request("/predict", {"language": "en", "sequence": [0] * 63})
assert status in (200, 503), (status, result)
if status == 200:
    assert result["language"] == "en", result
else:
    assert "not ready" in result["detail"], result
print("PASS valid landmark frame accepted without fabricated prediction")

print("API VALIDATION TESTS PASSED")
