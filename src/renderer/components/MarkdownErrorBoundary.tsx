import { Component, type ReactNode } from 'react';

interface Props {
  /** Raw message text — shown as plain <pre> fallback when markdown render throws */
  raw: string;
  children: ReactNode;
}

interface State {
  hasError: boolean;
}

/**
 * Guards markdown rendering. ReactMarkdown + plugins can throw on pathological
 * input (broken tables, exotic unicode, a malformed chart block); without a
 * boundary that exception unmounts the whole ChatView. Here we degrade to
 * plain text for the one bad message and the rest of the chat keeps working.
 */
export class MarkdownErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false };

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  componentDidCatch(error: unknown) {
    console.error('[MarkdownErrorBoundary] render failed:', error);
  }

  componentDidUpdate(prevProps: Props) {
    // New content (e.g. streaming text grew) — give rendering another chance.
    if (prevProps.raw !== this.props.raw && this.state.hasError) {
      this.setState({ hasError: false });
    }
  }

  render() {
    if (this.state.hasError) {
      return (
        <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', margin: 0, fontFamily: 'inherit' }}>
          {this.props.raw}
        </pre>
      );
    }
    return this.props.children;
  }
}
