APP        := webrtc-srv
PKG        := ./cmd/server
BIN_DIR    := bin
PORT       ?= 8080
DEPLOY_HOST ?= root@93.170.72.28
DEPLOY_DIR  ?= /opt/skypertc
DEPLOY_SVC  ?= skypertc
HEALTH_URL  ?= https://meet.zhandos.top/healthz

GO         := go
LDFLAGS    := -s -w
NPM        := npm

.DEFAULT_GOAL := help

.PHONY: help
help: ## Show this help
	@awk 'BEGIN {FS = ":.*##"; printf "Targets:\n"} /^[a-zA-Z_-]+:.*?##/ { printf "  \033[36m%-16s\033[0m %s\n", $$1, $$2 }' $(MAKEFILE_LIST)

.PHONY: run
run: web ## Build frontend then run server (port $(PORT))
	@set -a; [ -f .env ] && . ./.env; set +a; \
	PORT=$(PORT) $(GO) run $(PKG)

.PHONY: dev
dev: ## Vite dev server (HMR) + Go signaling backend, both in foreground
	@set -a; [ -f .env ] && . ./.env; set +a; \
	( $(GO) run $(PKG) & echo $$! > .gopid ; \
	  $(NPM) run dev ; \
	  kill $$(cat .gopid) 2>/dev/null ; rm -f .gopid )

node_modules: package.json
	$(NPM) install

.PHONY: web
web: node_modules ## Build Vite frontend into ./static
	$(NPM) run build

.PHONY: build
build: web ## Build production frontend + native server binary
	@mkdir -p $(BIN_DIR)
	$(GO) build -ldflags="$(LDFLAGS)" -o $(BIN_DIR)/$(APP) $(PKG)

.PHONY: build-linux
build-linux: web ## Cross-compile linux/amd64 binary for the server
	@mkdir -p $(BIN_DIR)
	GOOS=linux GOARCH=amd64 CGO_ENABLED=0 $(GO) build -ldflags="$(LDFLAGS)" -o $(BIN_DIR)/$(APP) $(PKG)

.PHONY: deploy
deploy: build-linux ## Build, upload binary + static, restart, healthcheck
	rsync -av $(BIN_DIR)/$(APP) $(DEPLOY_HOST):$(DEPLOY_DIR)/ 2>&1 | tail -2
	rsync -av --delete static/ $(DEPLOY_HOST):$(DEPLOY_DIR)/static/
	ssh $(DEPLOY_HOST) 'systemctl restart $(DEPLOY_SVC) && sleep 1 && systemctl is-active $(DEPLOY_SVC) && curl -s $(HEALTH_URL)'

.PHONY: deploy-static
deploy-static: web ## Rebuild + upload only static/ (no server restart)
	rsync -av --delete static/ $(DEPLOY_HOST):$(DEPLOY_DIR)/static/

.PHONY: logs
logs: ## Tail server logs (journalctl)
	ssh $(DEPLOY_HOST) 'journalctl -u $(DEPLOY_SVC) -f -n 100'

.PHONY: tidy
tidy: ## go mod tidy
	$(GO) mod tidy

.PHONY: fmt
fmt: ## go fmt ./...
	$(GO) fmt ./...

.PHONY: vet
vet: ## go vet ./...
	$(GO) vet ./...

.PHONY: test
test: ## Run all tests
	$(GO) test ./...

.PHONY: check
check: fmt vet test ## fmt + vet + test

.PHONY: clean
clean: ## Remove build artifacts (binary + vite output)
	rm -rf $(BIN_DIR) static

.PHONY: clean-all
clean-all: clean ## Also remove node_modules
	rm -rf node_modules
