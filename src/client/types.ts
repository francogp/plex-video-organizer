/** UI presentation state for the persistent error notification toast. */
export interface ErrorToastState {
  readonly visible: boolean;
  readonly count: number;
  readonly latestMessage: string;
}
