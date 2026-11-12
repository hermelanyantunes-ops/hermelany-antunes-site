"""Gera as linhas de contorno (isolinhas) usadas como elemento gráfico do site.

Uso: python3 scripts/gerar-contornos.py
Saída: src/partials/contornos.html (SVG inline) e src/assets/img/favicon.svg
Determinístico (semente fixa) — só precisa ser rodado se quiser outro desenho.
"""
import numpy as np
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
rng = np.random.default_rng(26332)

W, H = 600, 760
x = np.linspace(0, W, 300)
y = np.linspace(0, H, 380)
X, Y = np.meshgrid(x, y)

def g(cx, cy, sx, sy, a):
    return a * np.exp(-(((X - cx) / sx) ** 2 + ((Y - cy) / sy) ** 2))

Z = (g(250, 300, 190, 230, 1.0) + g(430, 560, 150, 130, 0.62)
     + g(120, 640, 120, 110, 0.30) + g(470, 150, 110, 120, 0.28))
# relevo suave
for _ in range(7):
    fx, fy = rng.uniform(0.004, 0.012, 2)
    px, py = rng.uniform(0, 2 * np.pi, 2)
    Z += 0.035 * np.sin(X * fx + px) * np.cos(Y * fy + py)

levels = np.linspace(Z.min() + 0.06, Z.max() - 0.02, 17)
fig, ax = plt.subplots()
cs = ax.contour(X, Y, Z, levels=levels)

paths = []
for i, segs in enumerate(cs.allsegs):
    for seg in segs:
        if len(seg) < 12:
            continue
        seg = seg[::4]
        d = "M" + " L".join(f"{p[0]:.0f} {p[1]:.0f}" for p in seg)
        closed = np.allclose(seg[0], seg[-1], atol=4)
        if closed:
            d += "Z"
        paths.append((i, d))

lines = []
for idx, (lvl, d) in enumerate(paths):
    strong = " c-forte" if lvl in (4, 9, 14) else ""
    lines.append(f'<path class="c{strong}" style="--i:{idx}" pathLength="1" d="{d}"/>')

svg = (f'<svg class="contornos" viewBox="0 0 {W} {H}" preserveAspectRatio="xMidYMid slice" '
       f'aria-hidden="true" focusable="false">\n' + "\n".join(lines) + "\n</svg>\n")
(ROOT / "src/partials/contornos.html").write_text(svg, encoding="utf-8")

# Favicon: três anéis orgânicos
def ring(r, wob, ph):
    t = np.linspace(0, 2 * np.pi, 60, endpoint=False)
    rr = r + wob * np.sin(3 * t + ph) + wob * 0.6 * np.cos(2 * t - ph)
    pts = [(32 + rr[k] * np.cos(t[k]), 32 + rr[k] * np.sin(t[k])) for k in range(len(t))]
    return "M" + " L".join(f"{a:.1f} {b:.1f}" for a, b in pts) + "Z"

fav = ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">'
       '<rect width="64" height="64" rx="14" fill="#1E3B32"/>'
       f'<g fill="none" stroke="#E8E0CF" stroke-width="2.6" stroke-linejoin="round">'
       f'<path d="{ring(22, 2.2, 0.3)}"/><path d="{ring(14.5, 1.8, 1.4)}"/><path d="{ring(7.5, 1.2, 2.2)}"/>'
       '</g></svg>\n')
(ROOT / "src/assets/img/favicon.svg").write_text(fav, encoding="utf-8")
print(len(paths), "contornos gerados")
