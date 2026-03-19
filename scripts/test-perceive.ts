/**
 * Standalone pipeline test — no server required.
 *
 * Runs a hand-crafted HTML page through the full Hollow pipeline and
 * prints the GDG Spatial output, confidence score, and JS errors.
 *
 * Run: npm run test:perceive
 */

import { buildDOM } from '../lib/hollow/dom';
import { resolveStyles } from '../lib/hollow/css-resolver';
import { calculateLayout } from '../lib/hollow/yoga-layout';
import { resolveGridLayout } from '../lib/hollow/grid-resolver';
import { generateGDGSpatial } from '../lib/hollow/gdg-spatial';
import { scoreConfidence } from '../lib/hollow/confidence';
import type { LayoutBox } from '../lib/hollow/yoga-layout';

// ─── Test page — mirrors the spec example ────────────────────────────────────

const TEST_HTML = `<!DOCTYPE html>
<html>
<head>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }

    nav {
      display: flex;
      flex-direction: row;
      width: 1280px;
      height: 44px;
      background: #333;
    }
    nav a {
      display: flex;
      align-items: center;
      width: 80px;
      height: 44px;
      padding: 0 10px;
      color: white;
      text-decoration: none;
    }

    main {
      display: flex;
      flex-direction: column;
      width: 1280px;
    }
    .section {
      padding: 40px;
    }
    .section h2 {
      margin-bottom: 16px;
      font-size: 24px;
    }
    .section input {
      display: block;
      width: 400px;
      height: 44px;
      margin-bottom: 8px;
    }
    .section button {
      display: block;
      width: 400px;
      height: 48px;
    }

    footer {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      width: 1280px;
      height: 60px;
      background: #333;
      margin-top: 8px;
    }
    footer a {
      display: flex;
      align-items: center;
      justify-content: center;
      color: white;
      text-decoration: none;
    }
  </style>
</head>
<body>
  <nav>
    <a href="/">Home</a>
    <a href="/about">About</a>
    <a href="/login">Login</a>
  </nav>

  <main>
    <section class="section">
      <h2>Sign in</h2>
      <input type="email" placeholder="Email" />
      <input type="password" placeholder="Password" />
      <button type="submit">Submit</button>
    </section>
  </main>

  <footer>
    <a href="/privacy">Privacy</a>
    <a href="/terms">Terms</a>
    <a href="/contact">Contact</a>
  </footer>
</body>
</html>`;

// ─── Run ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  Hollow — pipeline test');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  // Step 2: Happy DOM
  process.stdout.write('⟳  Happy DOM ... ');
  const { window, document, vitality } = await buildDOM(TEST_HTML, 'https://example.com');
  const jsErrors = vitality.getErrors();
  console.log(`done  (${jsErrors.length} JS error${jsErrors.length !== 1 ? 's' : ''})`);

  if (jsErrors.length > 0) {
    for (const e of jsErrors) {
      console.log(`   ⚠ ${e.type}: ${e.message}`);
    }
  }

  const body = document.body as unknown as Element;

  // Steps 3–4: CSS + Yoga
  process.stdout.write('⟳  Yoga Flexbox layout ... ');
  const { layoutMap, deductions: layoutDeductions } = calculateLayout(body, window);
  console.log(`done  (${layoutMap.size} elements)`);

  // Step 5: Grid resolver
  process.stdout.write('⟳  CSS Grid resolver ... ');
  const gridLayouts = new Map<Element, LayoutBox>();
  const gridMeta = new Map<Element, { col: number; row: number }>();
  const gridColCounts = new Map<Element, number>();

  function resolveGridContainers(el: Element): void {
    const styles = resolveStyles(el, window);
    const isGrid = styles.display === 'grid' || styles.display === 'inline-grid';

    if (isGrid) {
      const containerBox = layoutMap.get(el);
      if (containerBox) {
        const childStyles = new Map<Element, ReturnType<typeof resolveStyles>>();
        for (const child of Array.from(el.children)) {
          childStyles.set(child, resolveStyles(child, window));
        }
        const { childLayouts, resolvedPlacements, colCount } = resolveGridLayout(
          el, containerBox, styles, childStyles
        );
        gridColCounts.set(el, colCount);
        for (const [child, box] of childLayouts) {
          gridLayouts.set(child, box);
          const placement = resolvedPlacements.get(child);
          if (placement) {
            gridMeta.set(child, { col: placement.colStart, row: placement.rowStart });
          }
        }
      }
    }
    for (const child of Array.from(el.children)) resolveGridContainers(child);
  }

  resolveGridContainers(body);
  console.log(`done  (${gridLayouts.size} grid children)`);

  // Step 6: GDG Spatial
  process.stdout.write('⟳  GDG Spatial ... ');
  const gdg = generateGDGSpatial(body, window, layoutMap, gridLayouts, gridMeta, gridColCounts);
  console.log(`done  (${gdg.actionableCount} actionable, ~${gdg.tokenEstimate} tokens)\n`);

  // Step 7: Confidence
  const { score, deductions, tier } = scoreConfidence(layoutDeductions, jsErrors);

  // ── Output ──────────────────────────────────────────────────────────────────
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  GDG Spatial Output');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
  console.log(gdg.map);

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  Confidence');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
  console.log(`  Score : ${score.toFixed(2)}  (threshold 0.80)`);
  console.log(`  Tier  : ${tier.toUpperCase()}`);

  if (deductions.length > 0) {
    console.log('\n  Deductions:');
    for (const d of deductions) {
      console.log(`    -${d.amount.toFixed(2)}  ${d.reason}`);
    }
  } else {
    console.log('\n  No deductions — clean pass.');
  }

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  Element ID Map');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  for (const [id, el] of gdg.elements) {
    const coords = `x:${el.x} y:${el.y} w:${el.width} h:${el.height}`;
    const label = el.text ? `"${el.text}"` : el.inputType ? `input:${el.inputType}` : el.tag;
    console.log(`  [${id}] ${el.tag} ${label}  ${coords}`);
  }

  window.happyDOM.close();
  console.log('');
}

main().catch((err) => {
  console.error('\n✗ Pipeline error:', err);
  process.exit(1);
});
