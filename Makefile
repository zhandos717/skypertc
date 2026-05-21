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

.DEFAULT_GOAL := help

.PHONY: help
help: ## Show this help
	@awk 'BEGIN {FS = ":.*##"; printf "Targets:\n"} /^[a-zA-Z_-]+:.*?##/ { printf "  \033[36m%-14s\033[0m %s\n", $$1, $$2 }' $(MAKEFILE_LIST)

.PHONY: run
run: ## Run locally with hot env from .env (port $(PORT))
	@set -a; [ -f .env ] && . ./.env; set +a; \
	PORT=$(PORT) $(GO) run $(PKG)

.PHONY: dev
dev: run ## Alias for run

.PHONY: build
build: ## Build native binary into $(BIN_DIR)/$(APP)
	@mkdir -p $(BIN_DIR)
	$(GO) build -ldflags="$(LDFLAGS)" -o $(BIN_DIR)/$(APP) $(PKG)

.PHONY: build-linux
build-linux: ## Cross-compile linux/amd64 binary for the server
	@mkdir -p $(BIN_DIR)
	GOOS=linux GOARCH=amd64 CGO_ENABLED=0 $(GO) build -ldflags="$(LDFLAGS)" -o $(BIN_DIR)/$(APP) $(PKG)

.PHONY: deploy
deploy: build-linux ## Build, upload, restart service, healthcheck
	rsync -av $(BIN_DIR)/$(APP) $(DEPLOY_HOST):$(DEPLOY_DIR)/ 2>&1 | tail -2
	ssh $(DEPLOY_HOST) 'systemctl restart $(DEPLOY_SVC) && sleep 1 && systemctl is-active $(DEPLOY_SVC) && curl -s $(HEALTH_URL)'

.PHONY: deploy-static
deploy-static: ## Upload only static/ (no rebuild, no restart)
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
clean: ## Remove build artifacts
	rm -rf $(BIN_DIR)
