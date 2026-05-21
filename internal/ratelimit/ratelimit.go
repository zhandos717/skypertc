package ratelimit

import "sync"

type IPLimiter struct {
	mu   sync.Mutex
	conn map[string]int
	max  int
}

func New(max int) *IPLimiter {
	return &IPLimiter{conn: make(map[string]int), max: max}
}

func (l *IPLimiter) Allow(ip string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.conn[ip] >= l.max {
		return false
	}
	l.conn[ip]++
	return true
}

func (l *IPLimiter) Release(ip string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.conn[ip] > 0 {
		l.conn[ip]--
	}
}
