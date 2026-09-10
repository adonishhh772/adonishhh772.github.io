/**
 * Curated public repositories from github.com/adonishhh772.
 * Descriptions are taken from the repositories themselves — no invented claims.
 * Add or reorder entries here to change the "Open source & builds" sections.
 */
export interface GithubProject {
  name: string;
  description: string;
  url: string;
  language: string;
  category: 'AI & agents' | 'ML & RL research' | 'Automation & platform';
  /** Show this one on the home page strip. */
  featured?: boolean;
}

export const githubProjects: GithubProject[] = [
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
    name: 'NTTDATA',
    description: 'Production-shaped ACL GraphRAG interview demo (NTT DATA Option 1).',
    url: 'https://github.com/adonishhh772/NTTDATA',
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
