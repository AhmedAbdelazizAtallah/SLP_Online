# SLP Next - WebSocket integration test: roster, ping/pong, PIN flow, room-full
import asyncio, json, os
import websockets

PORT = os.getenv("WS_TEST_PORT", "8131")
URI = "ws://127.0.0.1:%s/ws" % PORT

async def main():
    a = await websockets.connect(URI + "?room=PINR&client=owner&pin=1234")
    first = json.loads(await asyncio.wait_for(a.recv(), 5))
    assert first["type"] == "roster", first
    b = await websockets.connect(URI + "?room=PINR&client=intruder&pin=9999")
    msg = json.loads(await asyncio.wait_for(b.recv(), 5))
    assert msg["type"] == "room-denied", msg
    print("PASS room-denied for wrong PIN")
    try:
        await asyncio.wait_for(b.recv(), 5); raise AssertionError("intruder socket not closed")
    except websockets.exceptions.ConnectionClosed:
        print("PASS intruder connection closed by server")
    c = await websockets.connect(URI + "?room=PINR&client=friend&pin=1234")
    fc = json.loads(await asyncio.wait_for(c.recv(), 5))
    assert fc["type"] == "roster", fc
    print("PASS correct PIN accepted")

    await a.send(json.dumps({"type": "ping", "t": 77}))
    got = None
    for _ in range(10):
        m = json.loads(await asyncio.wait_for(a.recv(), 5))
        if m.get("type") == "pong":
            got = m; break
    assert got and got.get("t") == 77, got
    print("PASS ping->pong heartbeat echo")

    await a.send(json.dumps({"type": "hello", "name": "Owner"}))
    got = None
    for _ in range(20):
        m = json.loads(await asyncio.wait_for(c.recv(), 5))
        if m.get("type") == "hello" and m.get("name") == "Owner":
            got = m; break
    assert got, "hello never relayed"
    print("PASS hello relayed with name")

    socks_extra = []
    full_seen = False
    for i in range(2):
        s = await websockets.connect(URI + "?room=PINR&client=x%d&pin=1234" % i)
        socks_extra.append(s)
        m = json.loads(await asyncio.wait_for(s.recv(), 5))
        if i == 1:
            assert m["type"] == "room-full", m
            full_seen = True
    assert full_seen, "never got room-full"
    print("PASS room-full at MAX_ROOM_SIZE")
    for s in socks_extra:
        try: await s.close()
        except Exception: pass
    await a.close(); await c.close()

    # Room/client identifiers are normalized and malformed payloads are ignored
    # without disconnecting healthy participants.
    d = await websockets.connect(URI + "?room=mix%20room!?&client=alpha!")
    assert json.loads(await asyncio.wait_for(d.recv(), 5))["self"] == "alpha"
    e = await websockets.connect(URI + "?room=MIXROOM&client=beta@")
    roster = json.loads(await asyncio.wait_for(e.recv(), 5))
    assert roster["self"] == "beta" and "alpha" in roster["ids"], roster
    await d.send(json.dumps({"type": "cap", "text": {"bad": True}}))
    await d.send(json.dumps({"type": "unknown", "text": "drop me"}))
    await d.send(json.dumps({"type": "cap", "text": "safe", "kind": "chat", "name": "Alpha"}))
    while True:
        relayed = json.loads(await asyncio.wait_for(e.recv(), 5))
        if relayed.get("type") == "cap":
            break
    assert relayed["text"] == "safe" and relayed["from"] == "alpha", relayed
    print("PASS malformed signaling ignored and identifiers normalized")
    await d.close(); await e.close()

asyncio.run(main())
print("WS TESTS PASSED")
