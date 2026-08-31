import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { afterEach, describe, expect, it } from 'vitest';

import { App } from './App';

afterEach(cleanup);

describe('foundation shell', () => {
  it('explains the session boundary and accepts a Matrix user ID without navigation', async () => {
    const user = userEvent.setup();
    render(<App />);

    expect(screen.getByRole('heading', { name: /important messages/i })).toBeInTheDocument();
    expect(screen.getByText(/browser session/i)).toBeInTheDocument();

    await user.type(screen.getByLabelText(/matrix user id/i), '@operator:example.test');
    await user.click(screen.getByRole('button', { name: /continue/i }));

    expect(screen.getByLabelText(/matrix user id/i)).toHaveValue('@operator:example.test');
  });

  it('has no automatically detectable accessibility violations', async () => {
    const { container } = render(<App />);
    const result = await axe.run(container);

    expect(result.violations).toEqual([]);
  });
});
