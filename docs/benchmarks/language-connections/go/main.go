package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"net"
	"os"
	"strconv"
	"sync/atomic"
)

type Sample struct {
	T string  `json:"t"`
	V float64 `json:"v"`
}
type Msg struct {
	Hub     string   `json:"hub"`
	Seq     int      `json:"seq"`
	Samples []Sample `json:"samples"`
}

var samples int64

func main() {
	base, _ := strconv.Atoi(os.Args[1])
	n, _ := strconv.Atoi(os.Args[2])
	for i := 0; i < n; i++ {
		ln, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", base+i))
		if err != nil {
			panic(err)
		}
		go func(ln net.Listener) {
			for {
				c, err := ln.Accept()
				if err != nil {
					continue
				}
				go handle(c)
			}
		}(ln)
	}
	select {}
}

func handle(c net.Conn) {
	defer c.Close()
	r := bufio.NewReaderSize(c, 4096)
	for {
		line, err := r.ReadBytes('\n')
		if err != nil {
			return
		}
		var m Msg
		if json.Unmarshal(line, &m) == nil {
			atomic.AddInt64(&samples, int64(len(m.Samples)))
		}
		if _, err := c.Write([]byte("A\n")); err != nil {
			return
		}
	}
}
