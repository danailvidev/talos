.PHONY: images image-control image-agent image-e2e

images: image-control image-agent image-e2e

image-control:
	docker build --tag talos-control:local .

image-agent:
	docker build --tag talos-agent:16 images/agent/v15

image-e2e:
	docker build --tag talos-e2e-agent:12 images/e2e/v11
