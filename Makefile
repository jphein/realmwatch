.PHONY: build dev oracle herald health install clean watch deploy

build:
	npm run build

dev:
	python3 map_server.py

oracle:
	python3 oracle_daemon.py --no-voice

herald:
	python3 realm_herald.py

health:
	./scripts/realm-health.sh

install:
	pip install -r requirements.txt
	npm install

clean:
	find . -type d -name __pycache__ -exec rm -rf {} +
	find . -type f -name '*.pyc' -delete
	rm -rf node_modules/.cache

watch:
	npm run watch

# Public files served at realm.watch via realm-portal
PORTAL_STATIC := $(HOME)/Projects/realm-portal/static
PUBLIC_HTML := wifi-guide.html report-card.html

deploy:
	@for f in $(PUBLIC_HTML); do \
		cp $$f $(PORTAL_STATIC)/$$f && echo "  $$f → realm-portal/static/"; \
	done
	@echo "Now run: cd ~/Projects/realm-portal && make deploy"
