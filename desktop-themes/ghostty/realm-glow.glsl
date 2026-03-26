// Realm Glow — subtle arcane vignette + faint golden bloom
// A gentle edge darkening with warm inner glow

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
    vec2 uv = fragCoord.xy / iResolution.xy;

    // Sample the terminal
    vec4 col = texture(iChannel0, uv);

    // Vignette: darken edges like an ancient grimoire
    vec2 center = uv - 0.5;
    float vignette = 1.0 - dot(center, center) * 0.8;
    vignette = smoothstep(0.2, 1.0, vignette);

    // Subtle warm glow — shift dark areas slightly toward gold
    float lum = dot(col.rgb, vec3(0.299, 0.587, 0.114));
    vec3 goldTint = vec3(0.12, 0.08, 0.02);
    col.rgb += goldTint * (1.0 - lum) * 0.15;

    // Apply vignette
    col.rgb *= vignette;

    fragColor = col;
}
