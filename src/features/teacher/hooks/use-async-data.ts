import { useCallback, useEffect, useRef, useState } from "react";
import { messageOf } from "../api/errors.ts";

/**
 * 表示時に1回読み込み、再読み込みもできるフック。最新のリクエストの結果だけを画面に反映する。
 * `fetcher` は useCallback で固定して渡す。
 * `onError` が true を返したエラーは呼び出し側で処理済みとして、`error` に入れない。
 */
export function useAsyncData<T>(fetcher: () => Promise<T>, onError?: (cause: unknown) => boolean) {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);
  const latestRequest = useRef(0);
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  const reload = useCallback(async () => {
    const request = ++latestRequest.current;
    setLoading(true);
    setError(undefined);
    try {
      const value = await fetcher();
      if (request === latestRequest.current) setData(value);
    } catch (cause) {
      if (request === latestRequest.current && !onErrorRef.current?.(cause)) setError(messageOf(cause));
    } finally {
      if (request === latestRequest.current) setLoading(false);
    }
  }, [fetcher]);

  useEffect(() => {
    // 開発時の StrictMode で effect が2回走っても、リクエストを1回にする。
    const timer = setTimeout(() => void reload());
    return () => {
      clearTimeout(timer);
      latestRequest.current++;
    };
  }, [reload]);

  return { data, setData, error, loading, reload };
}
