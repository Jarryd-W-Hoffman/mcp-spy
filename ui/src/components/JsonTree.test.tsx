// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { JsonTree } from './JsonTree';

describe('JsonTree', () => {
  it('renders scalars, empty containers and nested values', () => {
    const { container } = render(<JsonTree value={{ a: 1, b: true, c: null, d: [], e: {}, f: ['x', { g: 2 }] }} expandDepth={9} />);
    expect(container.textContent).toBe('▾{"a": 1,"b": true,"c": null,"d": [],"e": {},▾"f": ["x",▾{"g": 2}]}');
    expect(container.querySelector('.json-number')?.textContent).toBe('1');
    expect(container.querySelector('.json-null')).not.toBeNull();
  });

  it('collapses below the expand depth, and toggles open and shut', () => {
    const { container } = render(<JsonTree value={{ list: [1, 2], obj: { k: 1 } }} expandDepth={1} />);
    expect(screen.getByText('2 items')).toBeTruthy();
    fireEvent.click(screen.getByText('1 keys'));
    expect(container.textContent).toContain('"k": 1');
    fireEvent.click(screen.getAllByLabelText('Expand')[0]!);
    expect(container.textContent).toContain('1,2');
    fireEvent.click(screen.getAllByLabelText('Collapse')[0]!);
    expect(container.textContent).toBe('▸{2 keys}');
  });

  it('shortens long strings and parses JSON held in strings', () => {
    const long = 'y'.repeat(450);
    const { container } = render(<JsonTree value={[long, ' {"inner":1}', '[broken', 'plain']} />);
    fireEvent.click(screen.getByText('+50 chars'));
    expect(container.textContent).toContain(long);
    fireEvent.click(screen.getByText('less'));
    expect(container.textContent).not.toContain(long);
    expect(screen.getAllByText('parse JSON')).toHaveLength(1);
    fireEvent.click(screen.getByText('parse JSON'));
    expect(container.textContent).toContain('"inner": 1');
    fireEvent.click(screen.getByText('as string'));
    expect(container.textContent).toContain('" {\\"inner\\":1}"');
  });
});
