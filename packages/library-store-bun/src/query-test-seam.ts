export const queryTestSeam: {
  beforeHydrationQuery?: (
    relation:
      | "formats"
      | "tags"
      | "authors"
      | "languages"
      | "identifiers"
      | "customMetadata",
  ) => void;
} = {};
