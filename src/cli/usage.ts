import { CLI_INVOCATION } from '../config/cli-invocation.js'

/**
 * Spelled with the `npx` invocation rather than the bare binary name, for
 * the reason config/cli-invocation.ts documents: this package installs
 * nothing permanent, so `pliscelle-mcp` alone is not a command anyone can
 * run. A usage screen that lists commands the reader cannot type is worse
 * than no usage screen, since it reads as authoritative.
 *
 * The text is in French because a person reads it, in a terminal, at the
 * moment of setting the device up (issue #2036). Command and flag names stay
 * as they are.
 */
export const USAGE = `Utilisation :
  ${CLI_INVOCATION}                                   Démarre le serveur MCP sur stdio (ce que lance un client agentique)
  ${CLI_INVOCATION} --unattended                      Démarre le serveur MCP pour un agent qui tourne sans personne devant.
                                                   Les envois partent sans demande de confirmation, mais seulement vers un correspondant
                                                   déjà ratifié sur cette machine ; toute autre adresse est refusée. La purge est autorisée.
                                                   À déclarer uniquement sur une machine qui héberge un agent sans surveillance.
  ${CLI_INVOCATION} pair --code <CODE_D_APPAIRAGE> [--name <NOM_DE_L_APPAREIL>] [--no-login] [--device]
                                                   Enregistre cet appareil, puis le connecte et termine l'appairage (le code s'obtient dans l'onglet AIScellé de votre compte Pli Scellé).
                                                   --no-login s'arrête après l'enregistrement, pour un script ou une machine sans navigateur ; lancez login dans l'heure pour terminer.
                                                   --device connecte l'appareil par le flux d'appareil au lieu d'un navigateur local, pour un terminal sur une machine distante.
  ${CLI_INVOCATION} login [--device]                  Authentifie cet appareil et termine son appairage (flux navigateur par défaut, --device pour une machine sans navigateur)
  ${CLI_INVOCATION} identity                          Affiche l'adresse et la clé publique Ed25519 de cet appareil, ce qu'un correspondant doit connaître pour vous autoriser
  ${CLI_INVOCATION} ratify --list                     Liste les correspondants pas encore de confiance sur cet appareil
  ${CLI_INVOCATION} ratify --sender-id <ID> [--yes]   Ratifie un correspondant sur cet appareil (commande du paquet, jamais un outil MCP)
  ${CLI_INVOCATION} policy --status                   Indique si la politique locale anti-injection est activée
  ${CLI_INVOCATION} policy --enable|--disable         Active ou désactive la politique locale anti-injection (commande du paquet, jamais un outil MCP)
  ${CLI_INVOCATION} hook                              Hook de fin de tour pour un client agentique : signale à l'agent qu'un message attend (lit le JSON du client sur stdin)
`

export function printUsageAndExit(message?: string): never {
	if (message) console.error(message)
	console.error(USAGE)
	process.exit(1)
}
