import '@testing-library/jest-dom/vitest';
import { getLanguage, setLanguage } from '@jansetu/i18n';

// Every test starts in English (docs/I18N_PLAN.md §4.2): a test that switches language leaves nothing behind.
afterEach(async () => { if (getLanguage() !== 'en') await setLanguage('en'); });
