import { Component } from 'react';

// Contains a crash to the mockup panel instead of blanking the whole app.
// React error boundaries must be class components — there's no hook equivalent.
export default class MockupErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error('Mockup panel crashed:', error, info?.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <div style={{
          width: 375, minHeight: 200, display: 'flex', flexDirection: 'column',
          alignItems: 'center', justifyContent: 'center', gap: 10, padding: 24,
          textAlign: 'center', fontFamily: 'inherit', color: 'var(--text-secondary, #666)',
          fontSize: 14,
        }}>
          <div>the mockup hit a snag and couldn't render</div>
          <button
            type="button"
            onClick={() => { this.setState({ error: null }); this.props.onReset?.(); }}
            style={{
              padding: '8px 16px', borderRadius: 100, border: '1.5px solid var(--purple-border, #9b8afb)',
              background: 'var(--bg-elevated, #fff)', color: 'inherit', cursor: 'pointer', fontSize: 13,
            }}
          >
            reset
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
