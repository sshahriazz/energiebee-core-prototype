# Connection-handling micro-benchmark (Go, Rust, Elixir, Node)

Run on 23 October 2026. Purpose: replace opinion with measurement for one question: what does it cost, in memory and CPU, to hold many persistent device connections and parse and acknowledge small JSON messages?

## What it does

- Each server listens on 10 ports on 127.0.0.1. Protocol: one JSON line in (about 270 bytes, 10 samples), one `A\n` acknowledgement out.
- The load generator (`loadgen`, Go) opens 15,000 persistent connections, then runs phases: idle 10 s, steady (each connection sends every 10 s), burst (every 1 s), heavy (every 0.4 s, about 37,500 msg/s offered). Each phase has an 11 s warm-up that is not measured.
- Server memory (RSS) and CPU time come from `ps` on the server process.
- Same generator and same protocol for every server. Each server uses its language's standard JSON parsing.

## Servers

| Server | Notes |
|---|---|
| `go/` | goroutine per connection, `bufio` reader of 4 KB, `encoding/json` |
| `go512/` | same with a 512-byte reader (a simple tuning) |
| `node/` | Node 22, `net` module, single process |
| `rust/` | Tokio, `serde_json`, 4 KB `BufReader` |
| `elixir/srv.exs` | one process per connection, blocking `:gen_tcp.recv`, OTP `:json` |
| `elixir/srv_h.exs` | `active: :once` and hibernation after each message (a standard tuning for many idle connections) |

## Results

See `results-pass1-pass2-untuned.txt` (two passes, reverse order the second time), `results-tuned-elixir-hibernate.txt`, and the `go512` run in `results-tuned-first-attempt-elixir-bug.txt`. The first Elixir hibernation attempt in that file had a bug (it never re-armed the socket) and its Elixir numbers are invalid. `results-40k-failed.txt` is a 40,000-connection attempt that stalled at about 16,300 connections (macOS ephemeral port limit); it is kept for honesty and was not used.

## Limits, stated plainly

- One machine (Apple M3 Pro, 11 cores, macOS), loopback network, load generator on the same machine. Latency figures are dominated by that, not by the servers.
- Only 15,000 connections (a macOS port limit), not hundreds of thousands. Docker was not running, so no Linux run.
- A micro-benchmark of connection handling and JSON parsing. It does not test frameworks (Phoenix, Broadway, Axum, Fastify), database writes, clustering, fault tolerance, deployments or developer productivity.
- Implementations are naive but idiomatic, not tuned by experts for each runtime. Elixir changed a lot with one tuning step; others might too.
- Node ran as a single process, so it can use only one core.
- Two passes only. Run-to-run differences were small (a few percent) but this is not a statistical study.

## Reproduce

Needs Go, Rust (cargo), Elixir (OTP 27 or later, for the built-in `:json`), Node. Build the servers, then `./run.sh go 15000` (or `rust`, `elixir`, `elixirh`, `go512`, `node`).
