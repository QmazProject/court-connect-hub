import { QueryClient } from "@tanstack/react-query";
import { createRouter } from "@tanstack/react-router";
import { registerAssistantCacheInvalidation } from "./lib/assistant/catalog";
import { routeTree } from "./routeTree.gen";

export const getRouter = () => {
  const queryClient = new QueryClient();
  /* One subscription instead of an invalidation call at every mutation site: a
     manager who just saved a court must not be told by the assistant that it does
     not exist. */
  registerAssistantCacheInvalidation(queryClient);

  const router = createRouter({
    routeTree,
    context: { queryClient },
    scrollRestoration: true,
    defaultPreloadStaleTime: 0,
  });

  return router;
};
