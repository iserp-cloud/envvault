CONTROLLER_GEN ?= $(shell go env GOPATH)/bin/controller-gen
IMG ?= ghcr.io/iserp-cloud/envvault-operator:0.1.0
# Where the everything-to-apply file is written. The committed one is the generic example;
# for your own registry write elsewhere: make manifests IMG=registry.example/envvault-operator:1.0.0 OUT=../deploy/operator/install.yaml
OUT ?= config/install.yaml

.PHONY: generate manifests test build docker vectors

generate: ## deepcopy code
	$(CONTROLLER_GEN) object paths=./api/...

manifests: generate ## CRD, and $(OUT) (everything to apply)
	$(CONTROLLER_GEN) crd paths=./api/... output:crd:dir=config/crd
	{ cat config/manager/manager.yaml; echo '---'; cat config/crd/envvault.io_envvaultsecrets.yaml; echo '---'; cat config/crd/envvault.io_envvaultpushes.yaml; echo '---'; cat config/rbac/rbac.yaml; } \
	  | sed 's|image: .*envvault-operator:.*|image: $(IMG) # build from operator/Dockerfile|' > $(OUT)

test:
	go vet ./... && go test ./...

build:
	go build -o bin/manager ./cmd

docker: ## linux/amd64 image
	docker build --platform linux/amd64 --no-cache -t $(IMG) .

vectors: ## refresh the shared protocol vectors from the TypeScript side
	cd .. && pnpm vectors && cp test/vectors/zk-6.json operator/testdata/zk-6.json
