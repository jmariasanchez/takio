export const lifecycleTestSeam: {
  afterManagedFileInstalled?: (path: string) => void;
  beforeManagedFileCleanup?: (path: string) => void;
  beforeSourceFileCleanup?: (path: string) => void;
  duringManagedItemRemoval?: () => void;
} = {};
