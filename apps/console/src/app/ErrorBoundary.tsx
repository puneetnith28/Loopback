import { Component, type ErrorInfo, type ReactNode } from "react";
import { StateMessage } from "../design-system/components/DataView.tsx";

interface State { readonly failed: boolean; readonly resetKey: string | undefined }
interface Props { readonly children: ReactNode; /** Changing this (e.g. the route) clears a failure. */ readonly resetKey?: string }

/** Last-resort boundary: a plain message, never the raw error (which may contain untrusted data). */
export class ErrorBoundary extends Component<Props, State> {
  override state: State = { failed: false, resetKey: this.props.resetKey };
  static getDerivedStateFromError(): Partial<State> { return { failed: true }; }
  static getDerivedStateFromProps(props: Props, state: State): Partial<State> | null {
    return props.resetKey === state.resetKey ? null : { failed: false, resetKey: props.resetKey };
  }
  override componentDidCatch(_error: unknown, _info: ErrorInfo): void { /* no telemetry endpoint yet (backend requirement) */ }
  override render() {
    if (this.state.failed) {
      return <StateMessage icon="alert-circle" tone="danger" role="alert" centered title="This view failed to render" detail="Reload the page or go to another view. If it keeps happening, the console build may be out of date." />;
    }
    return this.props.children;
  }
}
