export const onRequest = ({
  request,
  env,
}: {
  request: Request;
  env: { BACKEND: Fetcher };
}): Promise<Response> => {
  return env.BACKEND.fetch(request);
};
