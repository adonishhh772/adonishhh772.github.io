/**
 * Curated public repositories from github.com/adonishhh772.
 * Descriptions are taken from the repositories themselves — no invented claims.
 * Add or reorder entries here to change the "Open source & builds" sections.
 */
export const GATHER_PROJECT_NAME = 'Gather';
export const SENTINEL_PROJECT_NAME = 'Architecture Sentinel';

export type LiveChromeIcon = 'mic' | 'shield';
export type LiveChromeTone = 'signal' | 'sentinel';

export interface GithubProject {
  name: string;
  description: string;
  /** Repository URL, or primary link when there is no separate live app. */
  url: string;
  language: string;
  category: 'AI & agents' | 'ML & RL research' | 'Automation & platform';
  /** Live deployment — opens in a new tab from cards and world hotspots. */
  liveUrl?: string;
  /** Show this one on the home page strip. */
  featured?: boolean;
  /** Icon for the world-chrome shortcut. Only live apps set this. */
  chromeIcon?: LiveChromeIcon;
  /** Accent for the chrome shortcut. Defaults to the amber signal tone. */
  chromeTone?: LiveChromeTone;
  /** Accessible name for the world-chrome shortcut. */
  chromeLabel?: string;
  /**
   * Text after the project name in the chrome promo bubble.
   * Omit it and the shortcut stays, with no popup.
   */
  chromeTip?: string;
}

export const githubProjects: GithubProject[] = [
  {
    name: SENTINEL_PROJECT_NAME,
    description:
      'Evidence-backed architecture and security analysis for software repositories, including AI agents, tools, RAG, and multi-agent workflows.',
    url: 'https://github.com/adonishhh772/architect-agent',
    liveUrl: 'https://adonishhh772.github.io/architect-agent/',
    language: 'TypeScript',
    category: 'AI & agents',
    featured: true,
    chromeIcon: 'shield',
    chromeTone: 'sentinel',
    chromeLabel: 'Architecture Sentinel — open the live architecture agent in a new tab',
    chromeTip: 'tap for the live architecture agent',
  },
  {
    name: GATHER_PROJECT_NAME,
    description:
      'Local-first meeting transcriber — Whisper in the browser, optional AI notes, private by default.',
    url: 'https://github.com/adonishhh772/Transcriber-agent',
    liveUrl: 'https://adonishhh772.github.io/Transcriber-agent/',
    language: 'TypeScript',
    category: 'AI & agents',
    featured: true,
    chromeIcon: 'mic',
    chromeLabel: 'Gather — open live meeting transcriber in a new tab',
    chromeTip: 'tap the mic for the live transcriber',
  },
  {
    name: 'Regshift',
    description:
      'Conduct-style change assurance layer with LangGraph orchestration and policy governance.',
    url: 'https://github.com/adonishhh772/Regshift',
    language: 'Python',
    category: 'AI & agents',
    featured: true,
  },
  {
    name: 'editdna-rank-studio',
    description:
      'AI reference-based ranking video generation platform — Tech Europe hackathon build.',
    url: 'https://github.com/adonishhh772/editdna-rank-studio',
    language: 'Python',
    category: 'AI & agents',
    featured: true,
  },
  {
    name: 'edumate',
    description: 'AG-UI hackathon project — an AI study companion (edumate).',
    url: 'https://github.com/adonishhh772/edumate',
    language: 'TypeScript',
    category: 'AI & agents',
    featured: true,
  },
  {
    name: 'PensionOS',
    description: 'PensionOS — Python build exploring pension domain workflows.',
    url: 'https://github.com/adonishhh772/PensionOS',
    language: 'Python',
    category: 'AI & agents',
  },
  {
    name: 'acme_relay',
    description: 'Relay service experiments in Python.',
    url: 'https://github.com/adonishhh772/acme_relay',
    language: 'Python',
    category: 'AI & agents',
  },
  {
    name: 'Carrier-ON-OFF',
    description:
      'DQN agent that switches 5G cells on and off, using energy efficiency as the reward signal.',
    url: 'https://github.com/adonishhh772/Carrier-ON-OFF',
    language: 'Python',
    category: 'ML & RL research',
    featured: true,
  },
  {
    name: 'ASM-PPO-RL-Agent',
    description:
      'PPO (actor-critic) reinforcement-learning agent for Advanced Sleep Mode in RAN.',
    url: 'https://github.com/adonishhh772/ASM-PPO-RL-Agent',
    language: 'Python',
    category: 'ML & RL research',
    featured: true,
  },
  {
    name: 'DL-on-3D-mesh',
    description: 'Deep learning on 3D meshes — research notebooks and models.',
    url: 'https://github.com/adonishhh772/DL-on-3D-mesh',
    language: 'Jupyter Notebook',
    category: 'ML & RL research',
  },
  {
    name: 'ai-cnn-yolo7',
    description: 'CNN / YOLOv7 computer-vision experiments.',
    url: 'https://github.com/adonishhh772/ai-cnn-yolo7',
    language: 'Jupyter Notebook',
    category: 'ML & RL research',
  },
  {
    name: 'processing-3d-Datasets',
    description: 'Pre-processing and decimation pipelines for 3D datasets.',
    url: 'https://github.com/adonishhh772/processing-3d-Datasets',
    language: 'Jupyter Notebook',
    category: 'ML & RL research',
  },
  {
    name: 'ML-basics',
    description: 'Foundations of machine learning on numerical datasets.',
    url: 'https://github.com/adonishhh772/ML-basics',
    language: 'Jupyter Notebook',
    category: 'ML & RL research',
  },
  {
    name: 'Automationv2',
    description: 'Report-processing automation built for Freshwave.',
    url: 'https://github.com/adonishhh772/Automationv2',
    language: 'Python',
    category: 'Automation & platform',
    featured: true,
  },
];

export const featuredGithubProjects = githubProjects.filter((p) => p.featured);

/** Curated apps with a public deployment — surfaced in world chrome, not on the pegboard. */
export const liveGithubProjects = githubProjects.filter((project) => Boolean(project.liveUrl));
