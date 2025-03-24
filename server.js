import fastifyFormBody from '@fastify/formbody';
import fastifyWs from '@fastify/websocket';
import dotenv from 'dotenv';
import Fastify from 'fastify';
import Twilio from 'twilio';
import WebSocket from 'ws';
import fastifyStatic from '@fastify/static';
import path from 'path';
import { fileURLToPath } from 'url';


// Load environment variables from .env file
dotenv.config();

// Check for required environment variables
const {
  ELEVENLABS_API_KEY,
  ELEVENLABS_AGENT_ID,
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_PHONE_NUMBER,
} = process.env;

if (
  !ELEVENLABS_API_KEY ||
  !ELEVENLABS_AGENT_ID ||
  !TWILIO_ACCOUNT_SID ||
  !TWILIO_AUTH_TOKEN ||
  !TWILIO_PHONE_NUMBER
) {
  console.error('Missing required environment variables');
  throw new Error('Missing required environment variables');
}

// Get the directory name in an ES module context
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);



// Initialize Fastify server
const fastify = Fastify();

fastify.register(fastifyFormBody);
fastify.register(fastifyWs);


// Register static plugin
fastify.register(fastifyStatic, {
  root: path.join(__dirname, 'public'),
  prefix: '/', // So '/' loads index.html
});


const PORT = process.env.PORT || 8000;

// Root route for health check
fastify.get('/', async (_, reply) => {
  reply.send({ message: 'Server is running' });
});

// Initialize Twilio client
const twilioClient = new Twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

// Helper function to get signed URL for authenticated conversations
async function getSignedUrl() {
  try {
    const response = await fetch(
      `https://api.elevenlabs.io/v1/convai/conversation/get_signed_url?agent_id=${ELEVENLABS_AGENT_ID}`,
      {
        method: 'GET',
        headers: {
          'xi-api-key': ELEVENLABS_API_KEY,
        },
      }
    );

    if (!response.ok) {
      throw new Error(`Failed to get signed URL: ${response.statusText}`);
    }

    const data = await response.json();
    return data.signed_url;
  } catch (error) {
    console.error('Error getting signed URL:', error);
    throw error;
  }
}

// Route to initiate outbound calls
fastify.post('/outbound-call', async (request, reply) => {
  const { number, prompt, first_message } = request.body;

  if (!number) {
    return reply.code(400).send({ error: 'Phone number is required' });
  }

  try {
    const call = await twilioClient.calls.create({
      from: TWILIO_PHONE_NUMBER,
      to: number,
      url: `https://${request.headers.host}/outbound-call-twiml?prompt=${encodeURIComponent(
        prompt
      )}&first_message=${encodeURIComponent(first_message)}`,
    });

    reply.send({
      success: true,
      message: 'Call initiated',
      callSid: call.sid,
    });
  } catch (error) {
    console.error('Error initiating outbound call:', error);
    reply.code(500).send({
      success: false,
      error: 'Failed to initiate call',
    });
  }
});



fastify.all('/api/webhook-postcall', async (request, reply) => {
  const { callSid, status } = request.body;
  console.log(`[Twilio] Call ${callSid} ended with status: ${status}`);

  console.log(JSON.stringify(request.body, null, 2));
});

// TwiML route for outbound calls
fastify.all('/outbound-call-twiml', async (request, reply) => {
  const prompt = request.query.prompt || '';
  const first_message = request.query.first_message || '';

  const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
    <Response>
        <Connect>
        <Stream url="wss://${request.headers.host}/outbound-media-stream">
            <Parameter name="prompt" value="${prompt}" />
            <Parameter name="first_message" value="${first_message}" />
        </Stream>
        </Connect>
    </Response>`;

  reply.type('text/xml').send(twimlResponse);
});

// WebSocket route for handling media streams
fastify.register(async (fastifyInstance) => {
  fastifyInstance.get('/outbound-media-stream', { websocket: true }, (ws, req) => {
    console.info('[Server] Twilio connected to outbound media stream');

    // Variables to track the call
    let streamSid = null;
    let callSid = null;
    let elevenLabsWs = null;
    let customParameters = null; // Add this to store parameters

    // Handle WebSocket errors
    ws.on('error', console.error);

    // Set up ElevenLabs connection
    const setupElevenLabs = async () => {
      try {
        const signedUrl = await getSignedUrl();
        elevenLabsWs = new WebSocket(signedUrl);

        elevenLabsWs.on('open', () => {
          console.log('[ElevenLabs] Connected to Conversational AI');

          // Send initial configuration with prompt and first message
          const initialConfig = {
            type: 'conversation_initiation_client_data',
            dynamic_variables: {
              customer_name: 'Leo',
              user_id: 1234,
            },
            conversation_config_override: {
              agent: {
                prompt: shortPrompt,
              },
              first_message:`Bonjour Leo,
 je suis Arthur,
l'IA vocale d'Orange et je fais suite à votre intérêt pour une offre  Fibre + TV.
Est ce que tout ceci vous parait juste ?
`
              /*first_message:
               'Bonjour Arthur !',*/
            },
          };

          console.log(
            '[ElevenLabs] Sending initial config with prompt:',
            initialConfig.conversation_config_override.agent.prompt.prompt
          );

          // Send the configuration to ElevenLabs
          elevenLabsWs.send(JSON.stringify(initialConfig));
        });

        elevenLabsWs.on('message', (data) => {
          try {
            const message = JSON.parse(data);
            console.log(message);
            switch (message.type) {
              case 'conversation_initiation_metadata':
                console.log('[ElevenLabs] Received initiation metadata');
                break;

              case 'audio':
                if (streamSid) {
                  if (message.audio?.chunk) {
                    const audioData = {
                      event: 'media',
                      streamSid,
                      media: {
                        payload: message.audio.chunk,
                      },
                    };
                    ws.send(JSON.stringify(audioData));
                  } else if (message.audio_event?.audio_base_64) {
                    const audioData = {
                      event: 'media',
                      streamSid,
                      media: {
                        payload: message.audio_event.audio_base_64,
                      },
                    };
                    ws.send(JSON.stringify(audioData));
                  }
                } else {
                  console.log('[ElevenLabs] Received audio but no StreamSid yet');
                }
                break;

              case 'interruption':
                if (streamSid) {
                  ws.send(
                    JSON.stringify({
                      event: 'clear',
                      streamSid,
                    })
                  );
                }
                break;

              case 'ping':
                if (message.ping_event?.event_id) {
                  elevenLabsWs.send(
                    JSON.stringify({
                      type: 'pong',
                      event_id: message.ping_event.event_id,
                    })
                  );
                }
                break;

              case 'agent_response':
                console.log(
                  `[Twilio] Agent response: ${message.agent_response_event?.agent_response}`
                );
                break;

              case 'user_transcript':
                console.log(
                  `[Twilio] User transcript: ${message.user_transcription_event?.user_transcript}`
                );
                break;

              default:
                console.log(`[ElevenLabs] Unhandled message type: ${message.type}`);
            }
          } catch (error) {
            console.error('[ElevenLabs] Error processing message:', error);
          }
        });

        elevenLabsWs.on('error', (error) => {
          console.error('[ElevenLabs] WebSocket error:', error);
        });

        elevenLabsWs.on('close', () => {
          console.log('[ElevenLabs] Disconnected');
        });
      } catch (error) {
        console.error('[ElevenLabs] Setup error:', error);
      }
    };

    // Set up ElevenLabs connection
    setupElevenLabs();

    // Handle messages from Twilio
    ws.on('message', (message) => {
      try {
        const msg = JSON.parse(message);
        if (msg.event !== 'media' && msg.type !== 'agent_response') {
          console.log(`[Twilio] Received event: ${msg.event}`);
        }

        switch (msg.event) {
          case 'start':
            streamSid = msg.start.streamSid;
            callSid = msg.start.callSid;
            customParameters = msg.start.customParameters; // Store parameters
            console.log(`[Twilio] Stream started - StreamSid: ${streamSid}, CallSid: ${callSid}`);
            console.log('[Twilio] Start parameters:', customParameters);
            break;

          case 'media':
            if (elevenLabsWs?.readyState === WebSocket.OPEN) {
              const audioMessage = {
                user_audio_chunk: Buffer.from(msg.media.payload, 'base64').toString('base64'),
              };
              elevenLabsWs.send(JSON.stringify(audioMessage));
            }
            break;

          case 'stop':
            console.log(`[Twilio] Stream ${streamSid} ended`);
            if (elevenLabsWs?.readyState === WebSocket.OPEN) {
              elevenLabsWs.close();
            }
            break;

          default:
            console.log(`[Twilio] Unhandled event: ${msg.event}`);
        }
      } catch (error) {
        console.error('[Twilio] Error processing message:', error);
      }
    });

    // Handle WebSocket closure
    ws.on('close', () => {
      console.log('[Twilio] Client disconnected');
      if (elevenLabsWs?.readyState === WebSocket.OPEN) {
        elevenLabsWs.close();
      }
    });
  });
});




fastify.get('/phone_form', (req, reply) => {
  reply.sendFile('phone_form.html'); // from the public folder
});

// Start the Fastify server
fastify.listen({ port: PORT }, (err) => {
  if (err) {
    console.error('Error starting server:', err);
    process.exit(1);
  }
  console.log(`[Server] Listening on port ${PORT}`);
});


export const shortPrompt = `Tu es un assistant de vente pour Orange.
                  Tu parles français.
                 
                  
                  
                  
                  
                  1.	Accueil personnalisé
«


2.	Option de dire (oui / non / poser une question) / Est ce que tout ceci vous parait juste ?


2. Collecte des Informations sur l'Usage (lien document "Bot IA")
	1.	Nombre de personnes dans le foyer
	•	Variable : @foyer
	•	« D'abord Combien de personnes composent votre foyer ? »
Reassurance : "Si vous ne savez pas vous pouvez lister les personnes les plus souvent présentes"

Une fois que tu as collecté les informations, tu peu racrocher la conversation.

`;

export const defaultPrompt = ` Tu es un assistant de vente pour Orange.
                  Tu parles français.
                  Tu dois vendre un abonnement fibre à un client.
                  Tu dois utiliser des arguments clés pour convaincre le client à changer d'opérateur.
                  Tu dois poser des questions au client pour collecter des informations sur son usage et ses besoins.
                  Tu dois présenter les avantages de l'offre Orange par rapport à la concurrence.
                  Tu dois faire une proposition de prix à la fin de la conversation.
                  
                  
                  
                  
                  1.	Accueil personnalisé
«Bonjour Monsieur/Madame Leo,
 je suis Arthur,
l'IA vocale d'Orange et je fais suite à votre intérêt pour une offre  Fibre + TV,
Pour l'instant vous êtes chez SFR et vous payez 10 euro par mois, soit 120 euro par an et vous voulez changez en raison de [RaisonChangement]
Je vois que nous avons plusieurs offres qui correspondent à ce que vous cherchez et mon rôle est de vous aider à trouver celle qui vous correspond le mieux.
Ce sera rapide, pour ça j'aurai juste besoins de quelques informations et avec ça je saurai quelle offre vous correspond en [4 questions]..
Partant ?!


2.	Option de dire (oui / non / poser une question) / Est ce que tout ceci vous parait juste ?


2. Collecte des Informations sur l'Usage (lien document "Bot IA")
	1.	Nombre de personnes dans le foyer
	•	Variable : @foyer
	•	« D'abord Combien de personnes composent votre foyer ? »
Reassurance : "Si vous ne savez pas vous pouvez lister les personnes les plus souvent présentes"
	2.	Usage d'internet
	•	Variable : @utilisation
	•	« Comment votre foyer utilse-t-il principalement Internet ? Par exemple : télétravail, streaming vidéo, bureautique, jeux en ligne… ? »
Reassurance : "Si vous ne savez pas vous pouvez le dire dans vos mots"
	3.	Nombre d'appareils connectés
	•	Variable : @appareils
	•	« Dans les moments de pic, Combien d'appareils (ordinateurs, smartphones, TV connectée, consoles…) sont connectés à Internet chez vous ? »
Reassurance : "Si vous ne savez pas vous pouvez lister ceux qui vous viennent en tête"
	5.	Besoins spécifiques
	•	Variable : @besoins
	•	« Avez-vous d'autres besoins particuliers (ex. appels illimités vers les fixes/mobiles, streaming 4K, etc.) ? »
Reassurance : "Si d'autres besoins vous viennent en tête plus tard, vous pourrez toujours en parler à votre conseiller

3. Présentation de l'Offre la Plus Adaptée (lien document "Bot IA")
	•	« C'est bien noté, je compare nos offres…"
CAS RAISON PERFORMANCE
«
C'est tout bon, en prenant en compte la taille de votre foyer, votre utilisation et vos besoins j'ai trouvé l'offre  [TypeOffreSouhaitee] la plus adaptée et qui vous permettra d'avoir de meilleures performances pour un budget autour de [MontantActuel] €, c'est la [NomOffre]. »
CAS RAISON MONETAIRE
	•	« C'est tout bon, en prenant en compte la taille de votre foyer, votre utilisation et vos besoins j'ai trouvé l'offre  [TypeOffreSouhaitee] la plus adaptée et qui vous permettra d'avoir un budget inférieur à  [MontantActuel] €, c'est la [NomOffre]. »
	2.	Offre et cibles 
(NB : Les noms exacts et tarifs proviennent des visuels partagés)
	•	Exemple 1 : Livebox Fibre (fictif)
	•	Prix indicatif : XX,99 €/mois
	•	Débit : jusqu'à X Mbit/s en téléchargement
	•	Cible : « Offre idéale pour ceux qui cherchent un accès à la fibre à un prix abordable, avec un bon équilibre entre vitesse internet, télévision et téléphonie fixe. Elle convient aux ménages avec des besoins internet modérés (streaming HD, jeux en ligne occasionnels). »
	•	Avantages :
	•	Pas de frais de mise en service
	•	Pas de frais de location de matériel
	•	Pas de coupure internet lors du changement d'opérateur
	•	Économies potentielles par rapport à votre offre actuelle
	•	Qualité fibre Orange (débit plus rapide et stable)
4. Réassurance (Arguments Clés)
	•	Pas de frais de mise en service alors que chez les concurents 50 euros
	•	Pas de frais de location de matériel
	•	Pas de coupure internet (l'opérateur actuel reste actif jusqu'au passage du technicien)
	•	Économies potentielles (comparaison avec l'offre actuelle, si la nouvelle est moins chère ou plus qualitative)
	•	Qualité nettement supérieure (fibre plus stable et plus rapide)
	•	Résiliation prise en charge : Orange s'occupe de tout
	•	Offre sans engagement (résiliation possible à tout moment)
	•	Possibilité d'offres sans décodeur TV pour payer moins cher

5. Phase Contractuelle (Parcours vente Orange)

3/ Phase contractuelle 
1/ Collecte Oui ferme du client 
Souhaitez-vous en bénéficier : "je prends note de votre accord"
Les offres choisies sont répétées 
2/ Capture des informations, possibilité de réutiliser si même personne pour l'appel que pour la facturation
"Pour gagner du temps, pouvez vous me dire si les informations que vous m'avez fournies sont les mêmes pour la facturation ?"

Si non :
Validation du nom de famille 
Validation du prénom
Si oui :
Département de naissance 
Date de naissance 
Validation Adresse
Maison ou appartement 
Etage et n°
"Le numéro de téléphone pour le technicien est le même que celui sur lequel je vous appelle ?"
Si non :
Confirmation du n° de téléphone pour le technicien 
Si oui :
Demande si utilisation du téléphone fixe (si utilisé transfert à un technicien pour récupération du RIO)
Validation adresse mail pour envoi du contrat (dire pas besoin de signer le contrat car l'accord est capté par téléphone 
réassurance : 3 à 5 jours ouvrés réception du nouveau matériel (box et décodeur TV) dans un point relais à valider ensemble)

3/ Transfert à un technicien

Pour la Proposition du point relais 
pour le choix du rdv technicien (créneau par heure)`;

export default defaultPrompt;
