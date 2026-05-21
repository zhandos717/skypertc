package config

import (
	"os"
	"strings"
)

type IceServer struct {
	URLs       []string `json:"urls"`
	Username   string   `json:"username,omitempty"`
	Credential string   `json:"credential,omitempty"`
}

type ClientConfig struct {
	IceServers []IceServer `json:"iceServers"`
}

func Env(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func splitCSV(s string) []string {
	parts := strings.Split(s, ",")
	out := parts[:0]
	for _, p := range parts {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	return out
}

func BuildIceServers() []IceServer {
	var servers []IceServer

	stun := Env("STUN_URLS", "stun:stun.l.google.com:19302,stun:stun1.l.google.com:19302")
	if stun != "" {
		urls := splitCSV(stun)
		if len(urls) > 0 {
			servers = append(servers, IceServer{URLs: urls})
		}
	}

	turnURLs := Env("TURN_URLS", "")
	if turnURLs != "" {
		servers = append(servers, IceServer{
			URLs:       splitCSV(turnURLs),
			Username:   os.Getenv("TURN_USERNAME"),
			Credential: os.Getenv("TURN_CREDENTIAL"),
		})
	}
	return servers
}
