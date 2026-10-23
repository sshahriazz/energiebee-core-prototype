use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpListener;

#[derive(serde::Deserialize)]
#[allow(dead_code)]
struct S { t: String, v: f64 }
#[derive(serde::Deserialize)]
#[allow(dead_code)]
struct M { hub: String, seq: u64, samples: Vec<S> }

#[tokio::main]
async fn main() {
    let a: Vec<String> = std::env::args().collect();
    let base: u16 = a[1].parse().unwrap();
    let n: u16 = a[2].parse().unwrap();
    for i in 0..n {
        let l = TcpListener::bind(("127.0.0.1", base + i)).await.unwrap();
        tokio::spawn(async move {
            loop {
                let (s, _) = match l.accept().await { Ok(x) => x, Err(_) => continue };
                s.set_nodelay(true).ok();
                tokio::spawn(async move {
                    let (r, mut w) = s.into_split();
                    let mut r = BufReader::with_capacity(4096, r);
                    let mut line = String::new();
                    loop {
                        line.clear();
                        if r.read_line(&mut line).await.unwrap_or(0) == 0 { break; }
                        if let Ok(m) = serde_json::from_str::<M>(&line) { let _ = m.samples.len(); }
                        if w.write_all(b"A\n").await.is_err() { break; }
                    }
                });
            }
        });
    }
    std::future::pending::<()>().await;
}
