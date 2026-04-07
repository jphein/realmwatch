"""Email adapter — sends alerts via SMTP."""

import logging
import smtplib
import ssl
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart
from . import ChannelAdapter, expand_template

log = logging.getLogger(__name__)

_EMAIL_TEMPLATE = """<div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
  <div style="background: {bg_color}; color: white; padding: 12px 20px; border-radius: 8px 8px 0 0;">
    <strong>RealmWatch [{severity}]</strong>
  </div>
  <div style="background: #1a1a2e; color: #e0e0e0; padding: 20px; border-radius: 0 0 8px 8px;">
    <p style="font-size: 16px; margin: 0 0 12px 0;">{text}</p>
    <p style="color: #888; font-size: 12px; margin: 0;">Node: {node} &bull; {timestamp}</p>
  </div>
</div>"""


class EmailAdapter(ChannelAdapter):
    name = "email"
    display_name = "Email (SMTP)"
    config_fields = [
        {"key": "smtp_host", "label": "SMTP Host", "type": "text", "default": ""},
        {"key": "smtp_port", "label": "SMTP Port", "type": "number", "default": 587},
        {"key": "smtp_tls", "label": "Use TLS", "type": "toggle", "default": True},
        {"key": "smtp_user", "label": "Username", "type": "text", "default": ""},
        {"key": "smtp_pass", "label": "Password", "type": "password", "default": ""},
        {"key": "from_addr", "label": "From Address", "type": "text", "default": "realmwatch@localhost"},
        {"key": "to_addrs", "label": "To Addresses (comma-separated)", "type": "text", "default": ""},
    ]

    def send(self, event, severity, config=None):
        cfg = config or self._config
        host = cfg.get("smtp_host", "")
        if not host:
            return False, "SMTP host not configured"

        to_raw = cfg.get("to_addrs", "")
        if not to_raw:
            return False, "No recipients configured"

        port = int(cfg.get("smtp_port", 587))
        use_tls = cfg.get("smtp_tls", True)
        user = cfg.get("smtp_user", "")
        password = cfg.get("smtp_pass", "")
        from_addr = cfg.get("from_addr", "realmwatch@localhost")
        to_addrs = [a.strip() for a in to_raw.split(",") if a.strip()]

        # Build email
        import time
        bg_colors = {"critical": "#dc3545", "warning": "#fd7e14", "info": "#0d6efd"}
        bg_color = bg_colors.get(severity, "#0d6efd")
        timestamp = time.strftime("%Y-%m-%d %H:%M:%S UTC", time.gmtime(event.get("ts", time.time())))

        subject = f"[RealmWatch {severity.upper()}] {event.get('text', 'Alert')[:80]}"

        html = _EMAIL_TEMPLATE.format(
            bg_color=bg_color,
            severity=severity.upper(),
            text=event.get("text", ""),
            node=event.get("node", "unknown"),
            timestamp=timestamp,
        )

        msg = MIMEMultipart("alternative")
        msg["Subject"] = subject
        msg["From"] = from_addr
        msg["To"] = ", ".join(to_addrs)
        msg.attach(MIMEText(event.get("text", ""), "plain"))
        msg.attach(MIMEText(html, "html"))

        try:
            if use_tls:
                ctx = ssl.create_default_context()
                server = smtplib.SMTP(host, port, timeout=10)
                server.starttls(context=ctx)
            else:
                server = smtplib.SMTP(host, port, timeout=10)

            if user and password:
                server.login(user, password)

            server.sendmail(from_addr, to_addrs, msg.as_string())
            server.quit()
            return True, None
        except smtplib.SMTPAuthenticationError:
            return False, "SMTP authentication failed"
        except smtplib.SMTPConnectError:
            return False, f"Cannot connect to {host}:{port}"
        except Exception as e:
            return False, str(e)
