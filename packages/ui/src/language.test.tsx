import '@testing-library/jest-dom/vitest';
import { useState } from 'react';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { catalogue, getLanguage, setLanguage, startLanguage } from '@jansetu/i18n';
import { LanguageScope, LanguageSwitcher, Parts, useLanguage } from './index.tsx';

catalogue('test-ui', { a: 'A' } as const, { './bn.json': () => Promise.reject(new Error('offline')) });

afterEach(async () => {
  await startLanguage('workspace', ['en']);
  localStorage.clear();
});

function Counter({ name }: { name: string }) {
  const [n, setN] = useState(0);
  return <button type="button" onClick={() => setN(n + 1)}>{name} {n}</button>;
}

describe('LanguageSwitcher', () => {
  it('shows nothing while the app offers English only (today)', async () => {
    await startLanguage('customer');
    const { container } = render(<LanguageSwitcher />);
    expect(container).toBeEmptyDOMElement();
  });

  it('lists each offered language in its own script and applies a choice', async () => {
    const user = userEvent.setup();
    await startLanguage('customer', ['en', 'hi', 'as', 'bn', 'or']);
    render(<LanguageSwitcher className="card" />);
    const list = screen.getByLabelText('Language');
    expect([...list.querySelectorAll('option')].map((o) => [o.textContent, o.lang])).toEqual([
      ['English', 'en'], ['हिन्दी', 'hi'], ['অসমীয়া', 'as'], ['বাংলা', 'bn'], ['ଓଡ଼ିଆ', 'or'],
    ]);
    await user.selectOptions(list, 'hi');
    await vi.waitFor(() => expect(getLanguage()).toBe('hi'));
    expect(localStorage.getItem('jansetu.lang')).toBe('hi');
    // Not translated yet: the label falls back to English, and says "Language" in English too.
    expect(screen.getByLabelText('Language · Language')).toHaveValue('hi');
  });

  it('says so when a language cannot load, and nothing changes', async () => {
    const user = userEvent.setup();
    await startLanguage('customer', ['en', 'bn']);
    render(<LanguageSwitcher />);
    await user.selectOptions(screen.getByLabelText('Language'), 'bn');
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load বাংলা. Check your connection and try again.');
    expect(getLanguage()).toBe('en');
    expect(localStorage.length).toBe(0);
  });
});

describe('LanguageScope', () => {
  it('mounts the page again on a change (its state starts over); what is outside keeps its state', async () => {
    const user = userEvent.setup();
    function Shell() {
      const lang = useLanguage();
      return <div><span>shell {lang}</span><Counter name="outside" /><LanguageScope><Counter name="page" /></LanguageScope></div>;
    }
    render(<Shell />);
    await user.click(screen.getByRole('button', { name: 'outside 0' }));
    await user.click(screen.getByRole('button', { name: 'page 0' }));
    expect(screen.getByRole('button', { name: 'page 1' })).toBeInTheDocument();
    await act(async () => { await setLanguage('pseudo'); });
    expect(screen.getByText('shell pseudo')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'outside 1' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'page 0' })).toBeInTheDocument();
  });
});

describe('Parts', () => {
  it('renders text and elements in order', () => {
    const { container } = render(<p><Parts of={['Collect ', <strong key="x">₹5.00</strong>, ' from the patient.']} /></p>);
    expect(container.innerHTML).toBe('<p>Collect <strong>₹5.00</strong> from the patient.</p>');
  });
});
