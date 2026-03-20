#!/usr/bin/env python3
"""Generate all 15 panel icons in Style B (Arcane Relics) via Bedrock Nova Canvas.

Output: assets/icons/style-b/{panel-key}.png (512x512)
Usage: python3 generate-icons.py [--force]
  --force  Regenerate even if file exists
"""
import boto3, json, base64, sys, os

client = boto3.client("bedrock-runtime", region_name="us-east-1")
MODEL = "amazon.nova-canvas-v1:0"

OUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "assets", "icons", "style-b")

# Style B: Arcane Relics — photorealistic 3D artifact on dark background
STYLE_PREFIX = (
    "Dark fantasy magical artifact icon, glowing with inner arcane energy, "
    "floating in void of deep purple darkness, ethereal wisps of emerald and gold light, "
    "photorealistic fantasy art, circular composition, "
)
STYLE_SUFFIX = (
    ", volumetric lighting, particle effects, gem-like quality, "
    "no text, no letters, no words"
)

# All 15 panel icons with descriptive subject prompts
PANELS = {
    "realm-panel":      "a cracked heart stone pulsing with green energy veins, ancient relic",
    "legend":           "a golden compass artifact with emerald inlay and spinning needle",
    "spellbook":        "a luminous crystal resting on an ancient open tome, purple aura radiating from pages",
    "realm-codex":      "an ornate scroll case with amber wax seal and golden filigree engravings",
    "quest-log":        "a bundle of scrolls with an emerald crystal and a glowing quill pen",
    "cartographer":     "a brass astrolabe with sapphire lens and rotating celestial rings",
    "energy-panel":     "a cluster of green and purple crystals growing from a stone pedestal, radiating power",
    "node-list":        "a golden hourglass with luminous sand flowing between glass chambers",
    "debug-panel":      "a scrying orb filled with swirling purple mist on a dark iron stand",
    "latency-panel":    "a sapphire tuning fork vibrating with visible sonic energy waves",
    "firewall-panel":   "an enchanted knight's shield with a glowing emerald core and runic wards",
    "wifi-panel":       "a crystal antenna tower crackling with indigo lightning bolts",
    "node-chat-dialog": "a mint-colored crystal ball resting on an ornate speaking pedestal",
    "arcane-grimoire":  "an ancient leather-bound book with a golden star bookmark and glowing pages",
    "scrying-terminal": "a frost crystal lens mounted in a brass monocle frame with etched runes",
    "scanner-panel":    "a golden magnifying glass with an emerald lens revealing hidden runes and glowing script",
}

SEED = 42
CFG_SCALE = 7.0
WIDTH = 512
HEIGHT = 512


def generate(prompt, output_path):
    """Call Bedrock Nova Canvas and save the resulting image."""
    body = json.dumps({
        "taskType": "TEXT_IMAGE",
        "textToImageParams": {"text": prompt},
        "imageGenerationConfig": {
            "numberOfImages": 1,
            "width": WIDTH,
            "height": HEIGHT,
            "cfgScale": CFG_SCALE,
            "seed": SEED,
        },
    })
    resp = client.invoke_model(
        modelId=MODEL, body=body,
        contentType="application/json", accept="application/json",
    )
    result = json.loads(resp["body"].read())
    img_b64 = result["images"][0]
    with open(output_path, "wb") as f:
        f.write(base64.b64decode(img_b64))
    print(f"  OK  {output_path}")


def main():
    force = "--force" in sys.argv
    os.makedirs(OUT_DIR, exist_ok=True)

    total = len(PANELS)
    generated = 0
    skipped = 0
    errors = 0

    print(f"Generating {total} Style B (Arcane Relics) panel icons")
    print(f"Output: {OUT_DIR}/")
    print(f"Config: {WIDTH}x{HEIGHT}, seed={SEED}, cfg={CFG_SCALE}")
    print()

    for i, (panel_key, subject) in enumerate(PANELS.items(), 1):
        out_path = os.path.join(OUT_DIR, f"{panel_key}.png")

        if os.path.exists(out_path) and not force:
            print(f"  [{i:2d}/{total}] {panel_key} — exists, skipping")
            skipped += 1
            continue

        prompt = STYLE_PREFIX + subject + STYLE_SUFFIX
        print(f"  [{i:2d}/{total}] {panel_key}...")

        try:
            generate(prompt, out_path)
            generated += 1
        except Exception as e:
            print(f"  ERR {panel_key}: {e}")
            errors += 1

    print()
    print(f"Done: {generated} generated, {skipped} skipped, {errors} errors")


if __name__ == "__main__":
    main()
