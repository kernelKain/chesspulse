import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { EXPLAINER_NEVERS, EXPLAINER_STEPS } from '../shared/onboarding.js';
import { Explainer } from './Explainer.js';

function headings(html: string): number[] {
  return [...html.matchAll(/<h([1-6])\b/g)].map((match) => Number(match[1]));
}

function orderedItems(html: string): string[] {
  const list = html.match(/<ol\b[^>]*>([\s\S]*?)<\/ol>/)?.[1] ?? '';
  return list.match(/<li\b/g) ?? [];
}

describe('Explainer markup', () => {
  it('uses h1 then h2 sections on the first screen', () => {
    const html = renderToStaticMarkup(createElement(Explainer, { showProgress: true }));
    assert.deepEqual(headings(html), [1, 2, 2]);
  });

  it('renders the five steps as one ordered list', () => {
    const html = renderToStaticMarkup(createElement(Explainer, { showProgress: true }));
    assert.equal(orderedItems(html).length, EXPLAINER_STEPS.length);
    for (const step of EXPLAINER_STEPS) assert.ok(html.includes(step.title), step.title);
  });

  it('marks the first step as the current one in text, not colour', () => {
    const firstRun = renderToStaticMarkup(createElement(Explainer, { showProgress: true }));
    assert.equal((firstRun.match(/aria-current="step"/g) ?? []).length, 1);
    assert.match(firstRun, />You are here</);
    assert.equal(firstRun.match(new RegExp(EXPLAINER_STEPS[0].title, 'g'))?.length, 1);

    const help = renderToStaticMarkup(createElement(Explainer, { headingLevel: 2 }));
    assert.equal(help.includes('aria-current'), false);
    assert.equal(help.includes('You are here'), false);
  });

  it('uses h2 then h3 sections when Help already owns the h1', () => {
    const html = renderToStaticMarkup(createElement(Explainer, { headingLevel: 2 }));
    assert.deepEqual(headings(html), [2, 3, 3]);
    assert.equal(html.includes('<h1'), false);
  });

  it('states every never-does limit in a plain list', () => {
    const html = renderToStaticMarkup(createElement(Explainer));
    for (const line of EXPLAINER_NEVERS) assert.ok(html.includes(line), line);
    assert.match(html, /<ul\b/);
    assert.match(html, /optional AI reading sends only your question, pasted games/);
  });
});
