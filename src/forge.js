// The Forge — agentic version.
//
// Instead of a hardcoded pipeline, the LLM gets a set of tools (ingest, analyze,
// set identity, add skill) and a goal, then drives the entire repo→bot process
// via the agentic loop. The LLM decides the order, the depth, and what to
// prioritize based on what it discovers about the repository.
//
// This is the "AI as the primary actor" architecture: the human provides a goal
// ("create a bot for this repo"), the LLM orchestrates everything else.
import { runAgentLoop, buildAgentSystemPrompt } from './agent-loop.js';
import { buildForgeTools } from './agent-tools.js';
import { createJob, jobStep, finishJob, failJob, recordJob } from './jobs.js';
import { truncate } from './util.js';

function forgeGoalPrompt(repo, intent, analysis) {
  return [
    `# Goal`,
    `Create a complete AI mascot for the repository "${repo}".`,
    intent ? `The owner wants: "${intent}"` : '',
    '',
    `# How to work`,
    `1. Start by calling ingest_github to index the repository's docs and README.`,
    `2. Check get_knowledge_stats to see what was indexed.`,
    `3. Design the mascot identity with set_identity — name it something friendly and relevant to the repo, pick an emoji, write a personality that matches the project's tone.`,
    `4. Install 1-3 skills with add_skill — reusable instruction packs for common questions (installation, API usage, configuration, troubleshooting).`,
    `5. Call run_analyzer to generate the app profile from the indexed knowledge.`,
    `6. Check get_profile to verify the profile is good.`,
    `7. Give your final summary: what you built, the mascot's identity, what it can answer, and any recommendations.`,
    '',
    `# Rules`,
    `- Be thorough: ingest first, understand the repo, THEN design the identity based on what you learned.`,
    `- The mascot's personality should match the project's tone (a game → playful, a database → technical, a docs tool → clear and helpful).`,
    `- Skills should cover the most common user questions you identified.`,
    `- Your final summary should include the mascot name, what it can answer, and the embed instruction.`,
  ].filter(Boolean).join('\n');
}

/**
 * Agentic Forge: the LLM drives the entire repo→bot pipeline via tools.
 * @param {object} p { store, llm, repo, intent, githubToken, serverUrl, vercelToken, projectName }
 * @param {function} onStep (name, detail, progress)
 * @returns {Promise<{ appId, appName, publicKey, steps, snippet, deploy }>}
 */
export async function forgeBot(p, onStep = () => {}) {
  const { store, llm } = p;
  const repo = String(p.repo || '').trim().replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, '');
  const intent = String(p.intent || '').trim();
  const serverUrl = String(p.serverUrl || process.env.MASCOT_PUBLIC_URL || 'http://localhost:4242').replace(/\/+$/, '');

  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) {
    throw new Error('repo must look like owner/name (or a full GitHub URL)');
  }
  if (!llm || !llm.configured) {
    throw new Error('Forge requires a configured LLM. The offline brain cannot orchestrate multi-step pipelines.');
  }

  const repoName = repo.split('/').pop();

  // Create the draft app — the forge tools operate on it.
  const app = store.createApp({ name: repoName, description: '' });

  // Build the forge tool registry.
  const tools = buildForgeTools(store, app, {
    githubToken: p.githubToken,
    onStep: (name, detail) => onStep(name, detail, 0),
  });

  // Build the agent system prompt.
  const goal = forgeGoalPrompt(repo, intent);
  const sys = buildAgentSystemPrompt(
    `You are the Mascotly Forge agent — you create AI mascots for software applications. You are now building a mascot for "${repo}".`,
    tools,
    // guardrails
    [
      '## Guardrails',
      '1. Ingest the repository FIRST before designing anything.',
      '2. The mascot identity must reflect what you learned from the repo.',
      '3. Skills must be genuinely useful for the repo\'s users.',
      '4. Run the analyzer before finishing.',
      '5. Do not invent facts about the repository — work from what you ingested.',
    ].join('\n'),
    `# Repository\n${repo}\n\n# Owner intent\n${intent || '(not specified — use your judgment)'}\n\n# Server URL for embed snippet\n${serverUrl}`
  );

  // Build the initial messages.
  const messages = [
    { role: 'system', content: sys },
    { role: 'user', content: goal },
  ];

  // Run the agentic loop.
  onStep('starting agentic forge…', 5);
  const result = await runAgentLoop({
    llm,
    tools,
    messages,
    maxSteps: 12, // the forge needs more steps than chat
    onStep: (step, toolName, args) => {
      onStep(`step ${step + 1}: ${toolName}`, '', 20 + (step / 12) * 70);
    },
    opts: { temperature: 0.3, maxTokens: 2000 },
  });

  // The forge agent returns a summary, but the real state is in the app record.
  const appFinal = store.getApp(app.id);
  if (!appFinal) {
    throw new Error('Forge agent did not produce a valid app');
  }

  onStep('packaging outputs…', 95);
  const snippet = [
    `<script src="${serverUrl}/widget/mascot-widget.js"></script>`,
    '<script>',
    '  window.Mascotly.init({',
    `    server: '${serverUrl}',`,
    `    appId: '${app.id}',`,
    `    publicKey: '${app.publicKey}'`,
    '  });',
    '</script>',
  ].join('\n');

  const { starterPageBundle } = await import('./starter-bundle.js');
  const bundle = starterPageBundle({ appName: appFinal.name, appId: app.id, publicKey: app.publicKey, serverUrl });

  // Optional Vercel deploy.
  let vercelDeployment = null;
  const projectName = 'mascotly-' + repoName.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40);
  if (p.vercelToken) {
    try {
      const { deployBundleToVercel } = await import('./deploy-vercel.js');
      vercelDeployment = await deployBundleToVercel({ token: p.vercelToken, projectName, files: bundle });
    } catch (err) {
      vercelDeployment = { error: truncate(String(err.message), 300) };
    }
  }

  onStep('done', 100);

  return {
    appId: app.id,
    appName: appFinal.name,
    publicKey: app.publicKey,
    mascot: appFinal.mascot,
    agentSummary: result.text,
    agentSteps: result.steps.map((st) => ({ tool: st.tool, args: st.args })),
    skills: (appFinal.skills || []).map((s) => s.name),
    knowledge: { chunks: appFinal.stats?.chunks || 0, sources: (store.getSources(app.id) || []).length },
    snippet,
    bundle,
    deploy: {
      vercel: vercelDeployment
        ? (vercelDeployment.error ? { error: vercelDeployment.error } : { url: vercelDeployment.url || ('https://' + (vercelDeployment.alias || projectName)), readyState: vercelDeployment.readyState || null, projectName })
        : {
            manual: true,
            steps: [
              'mkdir bot-starter && paste the provided bundle files',
              'cd bot-starter && npx vercel --prod',
            ],
            note: 'Or provide a Vercel token (vercelToken) and Forge deploys the starter page for you via the Vercel REST API.',
          },
      aws: {
        steps: [
          'Platform (this Mascotly server): push the Docker image to ECR and run it on ECS Fargate / App Runner behind an ALB (health check /api/health).',
          'Bot starter pages: upload the static bundle to S3 + CloudFront.',
          'Set MASCOT_DATABASE_URL (Postgres) + MASCOT_REDIS_URL in the task definition for production state and memory.',
        ],
      },
    },
    serverUrl,
  };
}

/** Job-wrapped entry used by routes/MCP. */
export function forgeBotAsJob(store, llm, params) {
  const job = createJob(params.appId || 'forge', 'forge', `Forge: ${truncate(params.repo, 70)}`);
  const promise = forgeBot({ ...params, store, llm }, (name, detail, progress) => jobStep(job, name, detail, progress))
    .then((result) => {
      finishJob(job, result);
      return result;
    })
    .catch((err) => {
      failJob(job, err);
      throw err;
    });
  return { job, promise };
}
