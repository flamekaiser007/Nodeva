#!/usr/bin/env python3
"""The real entrypoint for running a provider's compute worker.

Every other script in this project (scripts/e2e_demo.sh, scripts/p2p_demo.sh,
scripts/scale_demo.sh, e2e/run_e2e.sh...) has only ever constructed a
WorkerLink ad hoc, inline, for a test that starts it and tears it down
again within the same script. None of them is something a real provider
runs and leaves running -- this is that script. Enrolling a node (the
"My Machines" form's CLI snippet, which only prints identity + detected
hardware) never starts a live connection; nothing shows up in search and
no booking can ever be accepted until THIS process is running.

Usage (from the project root, after enrolling a node and noting its
node_id from "My Machines"):

    .venv/bin/python worker/run_worker.py \\
        --node-id <the node_id shown on your dashboard> \\
        --price-paise-hr <the price you enrolled it with>

Stop it with Ctrl+C -- that's a clean shutdown (WorkerLink.stop()), not a
crash; the platform sees a normal disconnect and marks the node offline.
"""
import argparse
import asyncio
import logging
import signal
import sys
from pathlib import Path

import websockets

sys.path.insert(0, str(Path(__file__).resolve().parent))

from nodeva_worker.identity import NodeIdentity
from nodeva_worker.reservations import ReservationStore
from nodeva_worker.link import WorkerLink, NodeRejected

log = logging.getLogger("nodeva.worker.cli")


def parse_args(argv=None):
    parser = argparse.ArgumentParser(
        description="Run the NODEVA compute worker for one already-enrolled node.")
    parser.add_argument("--node-id", required=True,
                         help="The node_id shown on your dashboard after enrolling (see 'My Machines').")
    parser.add_argument("--price-paise-hr", type=int, required=True,
                         help="Must match the price you enrolled this node with -- the RECEIPT this "
                              "worker signs for a booking includes it, and a mismatch fails verification "
                              "on the platform side (admitReceipt, backend/src/api/server.js).")
    parser.add_argument("--url", default="ws://localhost:3100/worker",
                         help="The platform's WebSocket URL (default: a local dev backend).")
    parser.add_argument("--identity-path", default=str(Path.home() / ".nodeva" / "node.pem"),
                         help="Must match the identity you enrolled with -- the same file the "
                              "enrollment snippet created.")
    parser.add_argument("--store-path", default=str(Path.home() / ".nodeva" / "reservations.sqlite"),
                         help="This node's own local reservation ledger (nodeva_worker/reservations.py) "
                              "-- the authoritative record of what it has committed to, independent of "
                              "whatever the platform's database says.")
    parser.add_argument("--peer-port", type=int, default=None,
                         help="Opt-in: also listen for direct peer connections from other nodes "
                              "(Phase 2 P2P discovery, nodeva_worker/peer.py). Omit to stay off, "
                              "matching this project's off-by-default posture for every optional feature.")
    parser.add_argument("--log-level", default="INFO", choices=["DEBUG", "INFO", "WARNING", "ERROR"])
    return parser.parse_args(argv)


def build_link(args) -> WorkerLink:
    """Split out from main() so the CLI's own argument-to-object wiring is
    unit-testable without needing a real event loop or a real network
    connection -- see worker/tests/test_run_worker.py."""
    identity_path = Path(args.identity_path).expanduser()
    store_path = Path(args.store_path).expanduser()
    identity = NodeIdentity.load_or_create(identity_path)
    store = ReservationStore(store_path)
    return WorkerLink(
        url=args.url, node_id=args.node_id, identity=identity, store=store,
        price_paise_hr=args.price_paise_hr, peer_port=args.peer_port,
    )


def main(argv=None):
    args = parse_args(argv)
    logging.basicConfig(level=args.log_level, format="%(asctime)s %(levelname)s %(message)s")

    link = build_link(args)
    log.info("starting worker for node %s -> %s", args.node_id, args.url)

    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, link.stop)
        except NotImplementedError:
            pass  # Windows has no add_signal_handler; Ctrl+C still raises KeyboardInterrupt below

    try:
        loop.run_until_complete(link.run_forever())
    except KeyboardInterrupt:
        link.stop()
    except NodeRejected as e:
        # A configuration mistake, not a crash -- a stack trace here buries
        # the one line that actually says what to change.
        log.error("%s", e)
        return 1
    except websockets.InvalidStatus as e:
        # The URL isn't a NODEVA worker endpoint at all (a 404 usually means
        # the host is right but the path isn't `/worker`, or the host simply
        # isn't this backend). Retrying cannot fix either, so fail loudly.
        log.error(
            "%s refused the WebSocket connection (%s). The --url must be the "
            "backend's own address ending in /worker, e.g. "
            "wss://your-backend.example.com/worker",
            args.url, e)
        return 1
    finally:
        loop.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
