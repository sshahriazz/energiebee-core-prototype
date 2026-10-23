package main

import (
	"bufio"
	"flag"
	"fmt"
	"math/rand"
	"net"
	"os/exec"
	"sort"
	"strconv"
	"strings"
	"sync/atomic"
	"time"
)

type Rec struct {
	lat  []int64
	n    int64
	errs int64
}

var (
	cur        atomic.Pointer[Rec]
	phase      atomic.Int32
	intervalNs atomic.Int64
	connected  int64
	connFail   int64
)

func psval(pid int, col string) string {
	out, err := exec.Command("ps", "-o", col+"=", "-p", strconv.Itoa(pid)).Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(out))
}

func cpuSeconds(s string) float64 {
	// formats: m:ss.hh or h:mm:ss.hh
	parts := strings.Split(s, ":")
	var t float64
	for _, p := range parts {
		v, _ := strconv.ParseFloat(p, 64)
		t = t*60 + v
	}
	return t
}

func newRec() *Rec { return &Rec{lat: make([]int64, 4_000_000)} }

func conn(i int, addr string) {
	var c net.Conn
	var err error
	for a := 0; a < 30; a++ {
		c, err = net.DialTimeout("tcp", addr, 5*time.Second)
		if err == nil {
			break
		}
		time.Sleep(time.Duration(100+rand.Intn(300)) * time.Millisecond)
	}
	if err != nil {
		atomic.AddInt64(&connFail, 1)
		return
	}
	atomic.AddInt64(&connected, 1)
	defer c.Close()
	r := bufio.NewReaderSize(c, 64)
	samples := strings.Repeat(`{"t":"temp","v":19.4},`, 9) + `{"t":"temp","v":19.4}`
	seen := int32(-1)
	seq := 0
	for {
		ph := phase.Load()
		if ph >= 9 {
			return
		}
		iv := intervalNs.Load()
		if iv == 0 {
			time.Sleep(20 * time.Millisecond)
			continue
		}
		if ph != seen {
			seen = ph
			time.Sleep(time.Duration(rand.Int63n(iv)))
			continue
		}
		seq++
		msg := `{"hub":"h` + strconv.Itoa(i) + `","seq":` + strconv.Itoa(seq) + `,"samples":[` + samples + "]}\n"
		rec := cur.Load()
		t0 := time.Now()
		c.SetDeadline(time.Now().Add(15 * time.Second))
		if _, err := c.Write([]byte(msg)); err != nil {
			atomic.AddInt64(&rec.errs, 1)
			return
		}
		if _, err := r.ReadString('\n'); err != nil {
			atomic.AddInt64(&rec.errs, 1)
			return
		}
		d := time.Since(t0)
		idx := atomic.AddInt64(&rec.n, 1) - 1
		if idx < int64(len(rec.lat)) {
			rec.lat[idx] = d.Nanoseconds()
		}
		if sl := time.Duration(iv) - d; sl > 0 {
			time.Sleep(sl)
		}
	}
}

func report(name string, rec *Rec, dur time.Duration, pid int, cpu0 float64, offered float64) float64 {
	n := atomic.LoadInt64(&rec.n)
	if n > int64(len(rec.lat)) {
		n = int64(len(rec.lat))
	}
	l := append([]int64(nil), rec.lat[:n]...)
	sort.Slice(l, func(a, b int) bool { return l[a] < l[b] })
	q := func(p float64) float64 {
		if len(l) == 0 {
			return 0
		}
		return float64(l[int(float64(len(l)-1)*p)]) / 1e6
	}
	cpu1 := cpuSeconds(psval(pid, "cputime"))
	rss, _ := strconv.Atoi(psval(pid, "rss"))
	fmt.Printf("%-8s offered=%8.0f/s achieved=%8.0f/s p50=%7.2fms p95=%7.2fms p99=%7.2fms max=%8.2fms errs=%d serverRSS=%6.0fMB serverCPUsec=%6.2f\n",
		name, offered, float64(n)/dur.Seconds(), q(0.5), q(0.95), q(0.99), q(1.0), atomic.LoadInt64(&rec.errs), float64(rss)/1024, cpu1-cpu0)
	return cpu1
}

func main() {
	base := flag.Int("base", 4001, "")
	ports := flag.Int("ports", 10, "")
	n := flag.Int("n", 40000, "")
	ramp := flag.Int("ramp", 1000, "conns/s")
	pid := flag.Int("pid", 0, "")
	idle := flag.Int("idle", 10, "")
	flag.Parse()

	rss0, _ := strconv.Atoi(psval(*pid, "rss"))
	fmt.Printf("baseline serverRSS=%.0fMB\n", float64(rss0)/1024)
	cur.Store(newRec())
	t0 := time.Now()
	tick := time.NewTicker(time.Second / time.Duration(*ramp/10))
	per := 10
	launched := 0
	for launched < *n {
		<-tick.C
		for k := 0; k < per && launched < *n; k++ {
			go conn(launched, "127.0.0.1:"+strconv.Itoa(*base+launched%*ports))
			launched++
		}
	}
	for time.Since(t0) < 120*time.Second && atomic.LoadInt64(&connected)+atomic.LoadInt64(&connFail) < int64(*n) {
		time.Sleep(200 * time.Millisecond)
	}
	fmt.Printf("ramp: connected=%d failed=%d in %.1fs\n", atomic.LoadInt64(&connected), atomic.LoadInt64(&connFail), time.Since(t0).Seconds())
	time.Sleep(time.Duration(*idle) * time.Second)
	rssIdle, _ := strconv.Atoi(psval(*pid, "rss"))
	live := atomic.LoadInt64(&connected)
	fmt.Printf("idle:    serverRSS=%.0fMB  => %.1f KB per connection (incl. runtime baseline %.0fMB: %.1f KB net)\n",
		float64(rssIdle)/1024, float64(rssIdle)/float64(live), float64(rss0)/1024, float64(rssIdle-rss0)/float64(live))

	runPhase := func(name string, iv time.Duration, secs int) {
		cur.Store(newRec())
		phase.Add(1)
		intervalNs.Store(iv.Nanoseconds())
		time.Sleep(11 * time.Second) // warm-up: let every connection finish its previous sleep and start the new cycle
		rec := newRec()
		cur.Store(rec)
		cpu0 := cpuSeconds(psval(*pid, "cputime"))
		time.Sleep(time.Duration(secs) * time.Second)
		offered := float64(live) / iv.Seconds()
		// ignore first iv of ramp-in jitter: durations are approximate
		report(name, rec, time.Duration(secs)*time.Second, *pid, cpu0, offered)
	}
	runPhase("steady", 10*time.Second, 30)
	runPhase("burst", 1*time.Second, 20)
	runPhase("heavy", 400*time.Millisecond, 15)
	intervalNs.Store(0)
	phase.Store(9)
	time.Sleep(500 * time.Millisecond)
}
