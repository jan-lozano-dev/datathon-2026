# Agentes

Todo lo que se le da a un agente de IA (Claude Code) para trabajar en este repositorio.

| Ruta | Qué es |
|---|---|
| [CLAUDE.md](CLAUDE.md) | Reglas y bucle de trabajo. El `CLAUDE.md` de la raíz lo importa. |
| [context.md](context.md) | El reto, el hardware, los datos y las cifras verificadas. |
| [skills/](skills/README.md) | Cuatro skills: placa, copiloto M3Kang, interfaz de hardware y publicación. |
| [subagents/](subagents/) | `board-checker` y `error-analyst`. |
| [commands/](commands/) | `experiment`: un cambio medido con `eval.py`. |
| [prompts/](prompts/) | Prompts que se usaron una vez para encargar trabajo a un agente. |

## Activarlos en Claude Code

Claude Code busca skills, subagentes y comandos en `.claude/`. Desde la raíz del repositorio:

```bash
mkdir -p .claude
ln -s ../agents/skills .claude/skills
ln -s ../agents/subagents .claude/agents
ln -s ../agents/commands .claude/commands
```

El `CLAUDE.md` de la raíz ya importa [CLAUDE.md](CLAUDE.md) y, a través de él, [context.md](context.md).

## Mantenerlos al día

Los agentes siguen lo que dicen estos ficheros. Si cambian el modelo, los puertos o las cifras, cámbialo aquí también. Las cifras salen de [../docs/results.md](../docs/results.md).
