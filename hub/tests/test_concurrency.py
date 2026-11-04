import time
from concurrent.futures import ThreadPoolExecutor

from conftest import add_readings


def test_concurrent_gets_never_500(client, db_path):
    import db
    conn = db.connect(db_path)
    now = int(time.time() * 1000)
    add_readings(conn, "ww-01/ch0", now - 600_000, [100.0] * 600)
    paths = ["/api/overview", "/api/alerts", "/api/devices", "/api/topology",
             "/api/health", "/api/readings?device_id=ww-01%2Fch0"] * 25
    with ThreadPoolExecutor(max_workers=16) as pool:
        codes = list(pool.map(lambda p: client.get(p).status_code, paths))
    assert codes.count(200) == len(paths), {c: codes.count(c) for c in set(codes)}
