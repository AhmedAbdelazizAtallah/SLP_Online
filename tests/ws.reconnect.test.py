# Regression test: reconnect with the same client id must NOT evict the new socket
import asyncio, json, sys
import websockets

URI = "ws://127.0.0.1:8131/ws"

async def recv_until(ws, want, timeout=5):
    while True:
        m = json.loads(await asyncio.wait_for(ws.recv(), timeout))
        if m.get("type") == want:
            return m

async def main():
    room = "RECONN"
    a = await websockets.connect(f"{URI}?room={room}&client=alice")
    assert (await recv_until(a, "roster"))["ids"] == []
    b = await websockets.connect(f"{URI}?room={room}&client=bob")
    assert "alice" in (await recv_until(b, "roster"))["ids"]
    await recv_until(a, "peer-joined")  # bob joined

    # bob's connection blips: reconnect with the SAME id
    b_ws2 = await websockets.connect(f"{URI}?room={room}&client=bob")
    await recv_until(b_ws2, "roster")

    # alice must NOT see a bogus peer-left for bob (stale socket cleanup)
    try:
        while True:
            m = json.loads(await asyncio.wait_for(a.recv(), timeout=3))
            assert m.get("type") != "peer-left", f"BUG: bogus peer-left after reconnect: {m}"
            if m.get("type") == "peer-joined":
                break
    except asyncio.TimeoutError:
        pass

    # bob's NEW socket must still be registered: alice's hello reaches him
    await a.send(json.dumps({"type": "hello", "to": "bob", "name": "Alice", "role": "deaf"}))
    m = await recv_until(b_ws2, "hello")
    assert m["from"] == "alice" and m["name"] == "Alice", m

    # and bob's new socket can still relay to alice
    await b_ws2.send(json.dumps({"type": "hello", "to": "alice", "name": "Bob", "role": "deaf"}))
    m = await recv_until(a, "hello")
    assert m["from"] == "bob", m

    # alice leaving must notify bob's live socket
    await a.close()
    m = await recv_until(b_ws2, "peer-left")
    assert m["id"] == "alice", m

    await b_ws2.close()
    print("RECONNECT RACE TEST PASSED")

asyncio.run(main())
