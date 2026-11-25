export {};

declare global {
  interface Window {
    openhack: {
      platform: string;
      invoke(channel: string, payload?: unknown): Promise<unknown>;
      onPush(listener: (payload: unknown) => void): () => void;
    };
  }
}
