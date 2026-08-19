export const lifecycleTestSeam: {
  afterManagedFileInstalled?: (path: string) => void;
  afterAdoptionJournalPlanned?: () => void;
  afterAdoptionFinalizing?: () => void;
  afterAdoptionRenamed?: () => void;
  beforeAdoptionRename?: (sourcePath: string, targetPath: string) => void;
  sameDevicePreflight?: (sourcePath: string, itemsDirectory: string) => boolean;
  beforeManagedFileCleanup?: (path: string) => void;
  beforeSourceFileCleanup?: (path: string) => void;
  duringManagedItemRemoval?: () => void;
} = {};
