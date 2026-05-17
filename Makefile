.PHONY: build dev oracle herald health install clean watch deploy cli-install cli-uninstall cli-doctor update-all-install update-all-uninstall

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

# Public files served at portal.realm.watch via realm-portal
PORTAL_STATIC := $(HOME)/Projects/realm-portal/static
PUBLIC_HTML := wifi-guide.html report-card.html

# wifi-guide.html lives in source with `{{WIFI_PSK}}` placeholder — the actual
# passphrase is in the local (gitignored) .env file and substituted at deploy.
# This keeps the PSK out of the public repo.
deploy:
	@if [ ! -f .env ] || ! grep -q '^WIFI_PSK=' .env; then \
		echo "  ✘ .env is missing WIFI_PSK=… — wifi-guide.html will deploy with literal {{WIFI_PSK}}"; \
		echo "  Add to .env:  WIFI_PSK=<your-passphrase>"; \
	fi
	@WIFI_PSK=$$(grep '^WIFI_PSK=' .env 2>/dev/null | cut -d= -f2- | tr -d '"' | head -1); \
	for f in $(PUBLIC_HTML); do \
		if [ -n "$$WIFI_PSK" ] && grep -q '{{WIFI_PSK}}' $$f; then \
			sed "s|{{WIFI_PSK}}|$$WIFI_PSK|g" $$f > $(PORTAL_STATIC)/$$f && \
				echo "  $$f → realm-portal/static/$$f  (PSK substituted)"; \
		else \
			cp $$f $(PORTAL_STATIC)/$$f && echo "  $$f → realm-portal/static/$$f"; \
		fi \
	done
	@echo "Now run: cd ~/Projects/realm-portal && make deploy"

# ---- realm CLI install ----
# Symlinks the realm dispatcher and every realm-* subcommand into ~/.local/bin,
# installs bash + zsh completion, and stamps a VERSION file. No sudo, no $PATH
# surgery — most modern distros put ~/.local/bin on $PATH already.

BIN_DIR := $(HOME)/.local/bin
BASH_COMP_DIR := $(HOME)/.local/share/bash-completion/completions
ZSH_COMP_DIR := $(HOME)/.local/share/zsh/site-functions

cli-install:
	@mkdir -p $(BIN_DIR) $(BASH_COMP_DIR) $(ZSH_COMP_DIR)
	@ln -sf $(CURDIR)/scripts/realm $(BIN_DIR)/realm
	@echo "  $(CURDIR)/scripts/realm → $(BIN_DIR)/realm"
	@for f in $(CURDIR)/scripts/cli/realm-*.sh; do \
	  name=$$(basename $$f .sh); \
	  ln -sf $$f $(BIN_DIR)/$$name; \
	  echo "  $$f → $(BIN_DIR)/$$name"; \
	done
	@for f in $(CURDIR)/scripts/realm-*.sh; do \
	  name=$$(basename $$f .sh); \
	  ln -sf $$f $(BIN_DIR)/$$name; \
	  echo "  $$f → $(BIN_DIR)/$$name"; \
	done
	@$(CURDIR)/scripts/realm completion bash > $(BASH_COMP_DIR)/realm
	@echo "  completion → $(BASH_COMP_DIR)/realm"
	@$(CURDIR)/scripts/realm completion zsh > $(ZSH_COMP_DIR)/_realm
	@echo "  completion → $(ZSH_COMP_DIR)/_realm"
	@git rev-parse --short HEAD > $(CURDIR)/scripts/cli/.realm-version 2>/dev/null || echo "dev" > $(CURDIR)/scripts/cli/.realm-version
	@echo ""
	@echo "Installed realm CLI. Open a new shell to load completion."
	@echo "Try: realm"

cli-uninstall:
	@rm -fv $(BIN_DIR)/realm $(BIN_DIR)/realm-*
	@rm -fv $(BASH_COMP_DIR)/realm
	@rm -fv $(ZSH_COMP_DIR)/_realm
	@echo "Uninstalled realm CLI."

cli-doctor:
	@echo "=== realm CLI doctor ==="
	@command -v realm >/dev/null && echo "  ✓ realm on PATH at $$(command -v realm)" || echo "  ✘ realm not on PATH (run: make cli-install)"
	@[ -f $(BASH_COMP_DIR)/realm ] && echo "  ✓ bash completion installed" || echo "  ✘ bash completion missing"
	@[ -f $(ZSH_COMP_DIR)/_realm ] && echo "  ✓ zsh completion installed" || echo "  ✘ zsh completion missing"
	@[ -f $(CURDIR)/scripts/cli/.realm-version ] && echo "  ✓ version stamp: $$(cat $(CURDIR)/scripts/cli/.realm-version)" || echo "  ✘ no version stamp"
	@command -v jq >/dev/null && echo "  ✓ jq found" || echo "  ✘ jq missing — human-readable output will degrade"
	@command -v curl >/dev/null && echo "  ✓ curl found" || echo "  ✘ curl missing — CLI cannot reach API"
	@command -v column >/dev/null && echo "  ✓ column found" || echo "  ✘ column missing — tables will be ugly"
	@curl --silent --max-time 2 --fail $${REALM_HOST:-http://localhost}/server-info >/dev/null 2>&1 \
	  && echo "  ✓ realm server reachable at $${REALM_HOST:-http://localhost}" \
	  || echo "  ! realm server unreachable (start map_server.py)"

# ---- daily update-all timer install ----
# Drops the systemd user units into ~/.config/systemd/user/ and enables the
# timer. NEVER auto-installs; JP runs `make update-all-install` to opt in.

SYSTEMD_USER_DIR := $(HOME)/.config/systemd/user

update-all-install:
	@mkdir -p $(SYSTEMD_USER_DIR)
	@cp $(CURDIR)/systemd/realm-update-all.service $(SYSTEMD_USER_DIR)/
	@cp $(CURDIR)/systemd/realm-update-all.timer   $(SYSTEMD_USER_DIR)/
	@systemctl --user daemon-reload
	@systemctl --user enable --now realm-update-all.timer
	@echo ""
	@echo "Enabled realm-update-all.timer (fires daily at ~03:00)."
	@echo "  Check next run:   systemctl --user list-timers realm-update-all"
	@echo "  Fire manually:    systemctl --user start realm-update-all.service"
	@echo "  Tail logs:        journalctl --user -u realm-update-all -f"
	@echo "  Disable:          make update-all-uninstall"

update-all-uninstall:
	@systemctl --user disable --now realm-update-all.timer 2>/dev/null || true
	@rm -fv $(SYSTEMD_USER_DIR)/realm-update-all.service
	@rm -fv $(SYSTEMD_USER_DIR)/realm-update-all.timer
	@systemctl --user daemon-reload
	@echo "Disabled realm-update-all.timer."
