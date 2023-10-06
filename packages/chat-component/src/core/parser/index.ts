import { readStream } from '../stream/index.js';

export async function parseStreamedMessages({
  chatThread,
  apiResponseBody,
  visit,
}: {
  chatThread: ChatThreadEntry[];
  apiResponseBody: ReadableStream<Uint8Array> | null;
  visit: () => void;
}) {
  const chunks = readStream<Partial<BotResponse>>(apiResponseBody);

  const streamedMessageRaw: string[] = [];
  const stepsBuffer: string[] = [];
  const followupQuestionsBuffer: string[] = [];
  let isProcessingStep = false;
  let isLastStep = false;
  let isFollowupQuestion = false;
  let stepIndex = 0;
  let textBlockIndex = 0;

  for await (const chunk of chunks) {
    let chunkValue = chunk.answer as string;
    if (chunkValue === '') {
      continue;
    }

    streamedMessageRaw.push(chunkValue);

    // we use numeric values to identify the beginning of a step
    // if we match a number, store it in the buffer and move on to the next iteration
    const LIST_ITEM_NUMBER = /(\d+)/;
    let matchedStepIndex = chunkValue.match(LIST_ITEM_NUMBER)?.[0];
    if (matchedStepIndex) {
      stepsBuffer.push(matchedStepIndex);
      continue;
    }

    // followup questions are marked either with the word 'Next Questions:' or '<<text>>' or both at the same time
    // these markers may be split across multiple chunks, so we need to buffer them!
    // TODO: support followup questions wrapped in <<text>> markers
    const matchedFollowupQuestionMarker = !isFollowupQuestion && chunkValue.includes('Next');
    if (matchedFollowupQuestionMarker) {
      followupQuestionsBuffer.push(chunkValue);
      continue;
    } else if (followupQuestionsBuffer.length > 0 && chunkValue.includes('Question')) {
      isFollowupQuestion = true;
      followupQuestionsBuffer.push(chunkValue);
      continue;
    } else if (isFollowupQuestion) {
      isFollowupQuestion = true;
      chunkValue = chunkValue.replace(/:?\n/, '');
    }

    // if we are here, it means we have previously matched a number, followed by a dot (in current chunk)
    // we can assume that we are at the beginning of a step!
    if (stepsBuffer.length > 0 && chunkValue.includes('.')) {
      isProcessingStep = true;
      matchedStepIndex = stepsBuffer[0];

      // we don't need the current buffer anymore
      stepsBuffer.length = 0;
    } else if (chunkValue.includes('\n\n')) {
      // if we are here, it means we may have reached the end of the last step
      // in order to eliminate false positives, we need to check if we currently
      // have a step in progress

      // eslint-disable-next-line unicorn/no-lonely-if
      if (isProcessingStep) {
        // mark the next iteration as the last step
        // so that all remaining text (in current chunk) is added to the last step
        isLastStep = true;
      }
    }

    // if we are at the beginning of a step, we need to remove the step number and dot from the chunk value
    // we simply clear the current chunk value
    if (matchedStepIndex || isProcessingStep) {
      if (matchedStepIndex) {
        chunkValue = '';
      }

      // set the step index that is needed to update the correct step entry
      stepIndex = matchedStepIndex ? Number(matchedStepIndex) - 1 : stepIndex;
      updateFollowingStepOrFollowupQuestionEntry({
        chunkValue,
        textBlockIndex,
        stepIndex,
        isFollowupQuestion,
        chatThread,
      });

      if (isLastStep) {
        // we reached the end of the last step. Reset all flags and counters
        isProcessingStep = false;
        isLastStep = false;
        isFollowupQuestion = false;
        stepIndex = 0;

        // when we reach the end of a series of steps, we have to increment the text block index
        // so that we start process the next text block
        textBlockIndex++;
      }
    } else {
      updateTextEntry({ chunkValue, textBlockIndex, chatThread });
    }
    const citations = parseCitations(streamedMessageRaw.join(''));
    updateCitationsEntry({ citations, chatThread });

    visit();
  }

  return streamedMessageRaw.join('');
}

// update the citations entry and wrap the citations in a sup tag
export function updateCitationsEntry({
  citations,
  chatThread,
}: {
  citations: Citation[];
  chatThread: ChatThreadEntry[];
}) {
  const lastMessageEntry = chatThread.at(-1);
  const updateCitationReference = (match, capture) => {
    const citation = citations.find((citation) => citation.text === capture);
    if (citation) {
      return `<sup>[${citation.ref}]</sup>`;
    }
    return match;
  };

  if (lastMessageEntry) {
    lastMessageEntry.citations = citations;

    lastMessageEntry.text.map((textEntry) => {
      textEntry.value = textEntry.value.replaceAll(/\[(.*?)]/g, updateCitationReference);
      textEntry.followingSteps = textEntry.followingSteps?.map((step) =>
        step.replaceAll(/\[(.*?)]/g, updateCitationReference),
      );
      return textEntry;
    });
  }
}

// parse and format citations
export function parseCitations(inputText: string): Citation[] {
  const findCitations = /\[(.*?)]/g;
  const citation: NonNullable<unknown> = {};
  let referenceCounter = 1;

  // extract citation (filename) from the text and map it to a reference number
  inputText.replaceAll(findCitations, (_, capture) => {
    const citationText = capture.trim();
    if (!citation[citationText]) {
      citation[citationText] = referenceCounter++;
    }
    return '';
  });

  return Object.keys(citation).map((text, index) => ({
    ref: index + 1,
    text,
  }));
}

// update the text block entry
export function updateTextEntry({
  chunkValue,
  textBlockIndex,
  chatThread,
}: {
  chunkValue: string;
  textBlockIndex: number;
  chatThread: ChatThreadEntry[];
}) {
  const { text: lastChatMessageTextEntry } = chatThread.at(-1) as ChatThreadEntry;

  if (!lastChatMessageTextEntry[textBlockIndex]) {
    lastChatMessageTextEntry[textBlockIndex] = {
      value: '',
      followingSteps: [],
    };
  }
  lastChatMessageTextEntry[textBlockIndex].value += chunkValue;
}

// update the following steps or followup questions entry
export function updateFollowingStepOrFollowupQuestionEntry({
  chunkValue,
  textBlockIndex,
  stepIndex,
  isFollowupQuestion,
  chatThread,
}: {
  chunkValue: string;
  textBlockIndex: number;
  stepIndex: number;
  isFollowupQuestion: boolean;
  chatThread: ChatThreadEntry[];
}) {
  // following steps and followup questions are treated the same way. They are just stored in different arrays
  const { followupQuestions, text: lastChatMessageTextEntry } = chatThread.at(-1) as ChatThreadEntry;
  if (isFollowupQuestion && followupQuestions) {
    followupQuestions[stepIndex] = (followupQuestions[stepIndex] || '') + chunkValue;
    return;
  }

  if (lastChatMessageTextEntry && lastChatMessageTextEntry[textBlockIndex]) {
    const { followingSteps } = lastChatMessageTextEntry[textBlockIndex];
    if (followingSteps) {
      followingSteps[stepIndex] = (followingSteps[stepIndex] || '') + chunkValue;
    }
  }
}
