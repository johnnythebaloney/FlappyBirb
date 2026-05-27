import "./style.css";

import {
    Observable,
    catchError,
    filter,
    fromEvent,
    interval,
    map,
    merge,
    pipe,
    scan,
    switchMap,
    take,
    throttleTime,
} from "rxjs";
import { fromFetch } from "rxjs/fetch";

// ============================================================================
// CONSTANTS
// ============================================================================

const Viewport = {
    CANVAS_WIDTH: 600,
    CANVAS_HEIGHT: 400,
} as const;

const Birb = {
    WIDTH: 42,
    HEIGHT: 30,
} as const;

const Constants = {
    PIPE_WIDTH: 50,
    // ~60 FPS for smooth animation
    TICK_RATE_MS: 12,
    // pixels per tick
    LEPIPER: 1,
    //gravity
    LEGRAV: 0.3,
    //How strong the birb can fight against gravity (negative = up)
    WING_STR: -4,
    // minimum bounce velocity
    BOUNCE_VELOCITY_MIN: -3,
    // maximum bounce velocity
    BOUNCE_VELOCITY_MAX: -1,
    // bird starting Y position
    BIRB_STARTER_POS: 200,
    //max no of birb lives
    MAX_O_LIVES: 3,
    // ghost trail length
    GHOST_TRAIL_LENGTH: 15,
    // pipe gap size multiplier (makes gaps wider)
    PIPE_GAP_MULTIPLIER: 1.5,
    // minimum gap size (in pixels)
    MIN_PIPE_GAP: 120,
    // spawn delay (seconds to add to CSV times)
    PIPE_SPAWN_DELAY: 0.5,
    // speed multipler for speedups
    SPEEDUP_MULTIPLIER: 2,
    // duration of invincibility power-up (frames at 60fps)
    TIME_OF_INVINCIBILITY: 180, // 3 seconds * 60fps
    // duration of speed power-up (frames at 60fps)
    TURBO_DURATION: 120, // 2 seconds * 60fps
    // record position every N ticks (for ghost)
    GHOST_REC_INTERVAL: 3,
    // ghost bird opacity
    GHOST_OPACITY: 0.4,
    // power-up movement speed (vertical)
    POW_BOUNCE_SPEED: 2,
    // power-up bounce amplitude (how far they move up/down)
    POW_BOUNCE_AMPLITUDE: 80,
    //Damaged invincibility frames (2 seconds * 60fps)
    DAMAGED_INVINCIBILITY: 120,
} as const;

export const extraConst = {
    extraLifeCost: 10,
    tradeCooldown: 1200,
};

// ============================================================================
// TYPES
// ============================================================================

// User input

type Key = "Space" | "KeyT";

// Types for game objects

type Pipe = Readonly<{
    x: number;
    gapY: number; // Y position of gap center
    gapHeight: number; // Height of gap
    time: number; // When this pipe should appear
    id: number; // Unique identifier
}>;

type PipeData = Readonly<{
    gap_y: number;
    gap_height: number;
    time: number;
}>;

type Birb = Readonly<{
    x: number;
    y: number;
    veloY: number; // vertical velocity (positive = down, negative = up)
    invincibilityFrames: number; // Frames of invincibility after collision
}>;

type Pos = Readonly<{
    x: number;
    y: number;
    frame?: number; // Optional frame number for ghost replay
}>;

type PowerUpKind = "invincibility" | "i am speed";

type PowerUp = Readonly<{
    id: number;
    x: number;
    y: number;
    typoPowerUps: PowerUpKind;
}>;

// State processing

type State = Readonly<{
    gameEnd: boolean;
    gameWon: boolean; // true when birb passes through all pipes
    time: number; // Current game time in seconds
    birb: Birb; // Birb position and physics
    pipes: readonly Pipe[]; // All active pipes on screen
    pipeData: readonly PipeData[]; // All pipe data from CSV
    nextPipeIndex: number; // Index of next pipe to spawn
    score: number; // Current score
    lives: number; // Remaining lives
    lastScoredPipeId: number; // ID of last pipe that contributed to score
    randomSeed: number; // Random seed for pipe generation
    frame: number;
    currRec: readonly Pos[];
    prevRec: readonly Pos[];
    powerUps: readonly PowerUp[];
    nextPowerUpId: number;
    speedTimer: number;
}>;

const initialState: State = {
    gameEnd: false,
    gameWon: false,
    time: 0,
    birb: {
        x: Viewport.CANVAS_WIDTH * 0.3,
        y: Constants.BIRB_STARTER_POS,
        veloY: 0,
        invincibilityFrames: 0,
    },
    pipes: [],
    pipeData: [],
    nextPipeIndex: 0,
    score: 0,
    lives: Constants.MAX_O_LIVES,
    lastScoredPipeId: -1,
    randomSeed: 42,
    frame: 0,
    currRec: [],
    prevRec: [],
    powerUps: [],
    nextPowerUpId: 0,
    speedTimer: 0,
};

// ============================================================================
// STATE MANAGEMENT & GAME LOGIC
// ============================================================================

//Class representing a pseudo random number generator (RNG)(Code Taken from week 4 applied )
abstract class RNG {
    //Modulus params for the linear congruential generator (LCG)
    private static m = 0x80000000; // 2^31
    //Multiplier for the LCG
    private static a = 1103515245;
    //Increment for LCG
    private static c = 12345;

    /**
     *Hash function using a LCG generator formula
     To generate the next pseudo-random integer based on the input seed
     * @param seed - the current seed val
     * @returns The next pseudo-random int 
     */
    public static hash = (seed: number): number =>
        (RNG.a * seed + RNG.c) % RNG.m;

    /**
     * Function to scale the integer hash to a Floating point number in the range [-1, 1]
     * @param hash - The integer hash to scale
     * @returns Floating point val between -1,1
     */
    public static scale = (hash: number): number =>
        //Scale the hash to [-1,1]
        (2 * hash) / (RNG.m - 1) - 1;

    /**
     * Generate a pseudo-random val and the next seed from the given seed
     * @param seed - the current seed val
     * @returns An object containing the pseudo-random val and the next seed
     */

    public static randoSeed = (
        seed: number,
    ): { val: number; nxtSeed: number } => {
        //using the hash function to generatre the next seed
        const nxtSeed = RNG.hash(seed);
        //scale the value to only -1,1
        const randoVal = RNG.scale(nxtSeed);
        //Return both the scaled random val and the next seed
        return { val: randoVal, nxtSeed };
    };
}

/**
 * Returns the absolute value of a number.
 * @param x The input number.
 * @returns The absolute value of the input number.
 */
const pureMathAbs = (x: number): number => (x <= 0 ? 0 - x : x);

/**
 * Returns the max val of a number
 * @param leBigger
 * @param leSmaller
 * @returns The max value of a number
 */
const pureMathMax = (leBigger: number, leSmaller: number): number =>
    leBigger > leSmaller ? leBigger : leSmaller;

//To check whether the player can afford to trade their score for an extra life
export const logicOfTrades = (state: State): boolean => {
    //Cost of a life in score
    const liveCost = extraConst.extraLifeCost;
    //Maximum allowed life
    const maxLives = Constants.MAX_O_LIVES;
    //To check if the player can afford the trade
    return state.score >= liveCost && state.lives < maxLives;
};

//To return a new state with one more life and a reduced socre after trading
const scoreForLifeTrdr = (state: State): State => {
    return {
        //copy the state
        ...state,
        //update the lives + 1
        lives: state.lives + 1,
        //subtract the score
        score: state.score - extraConst.extraLifeCost,
    };
};

//if allowed, update the lives of the bird and the score, else return the original state
export const tradeApplier = (state: State): State =>
    //To check whether the trade is possible
    logicOfTrades(state)
        ? (() => {
              const newState = scoreForLifeTrdr(state);
              return {
                  //Copy the existing state
                  ...state,
                  //Update the live
                  lives: newState.lives,
                  //update the score
                  score: newState.score,
              };
          })()
        : //State remain unchanged if the trade is not possible
          state;

/** Generate a new power-up */
export const powGenerator = (
    //curr game state
    state: State,
    //RNG seed for psuedorandomness
    seed: number,
): { powerUp: PowerUp; nextSeed: number } => {
    //get random val and the next seed
    const { val, nxtSeed } = RNG.randoSeed(seed);
    //Decide power-up type: negative value gives "invincibility", positive gives "i am speed"
    const typoPowerUps: PowerUpKind = val < 0 ? "invincibility" : "i am speed";

    // Get pipe data for current pipe, fallback to middle if missing
    const currentPipeData = state.pipeData[state.nextPipeIndex];
    //Y position for the powerup to spawn
    const gapY = currentPipeData ? currentPipeData.gap_y : 0.5;

    return {
        powerUp: {
            //unique pow up id
            id: state.nextPowerUpId,
            //to spawn off the right edge
            x: Viewport.CANVAS_WIDTH + 10,
            //Y position for the powerup to spawn
            y: gapY * Viewport.CANVAS_HEIGHT,
            //power up type
            typoPowerUps,
        },
        //Return the next seed
        nextSeed: nxtSeed,
    };
};

/** Handles power-up logic using the provided seed and returns updated list and the next seed */
export const pwrHandler = (
    //curr game state
    state: State,
    //RNG seed for randomness
    seed: number,
): { powerUps: readonly PowerUp[]; nextSeed: number } => {
    const { val, nxtSeed } = RNG.randoSeed(seed);
    //if the random val is >= 0.5  then dont spawn the power ups
    return val >= -0.5
        ? // Otherwise, spawn a new power-up and add to the list
          { powerUps: state.powerUps, nextSeed: nxtSeed }
        : (() => {
              const { powerUp, nextSeed } = powGenerator(state, nxtSeed);
              return {
                  // Add new power-up to array
                  powerUps: [...state.powerUps, powerUp],
                  // Pass on updated seed
                  nextSeed,
              };
          })();
};

/**
 * Parses CSV content and returns pipe data
 * @param csvContent The raw CSV content string
 * @returns Array of pipe data objects
 */
const PIPE_SPAWN_DELAY = 1.0; // seconds between pipes

//To split the csv content into lines, and skipping the header
const linesOData = (csvContent: String) => {
    return csvContent.trim().split("\n").slice(1);
};

//Convert the csv line into a pipe data obj, and applying the spawn delay
const dataPiper = (line: String, idx: number): PipeData => {
    const [gap_y, gap_height, time] = line.split(",").map(Number);
    return { gap_y, gap_height, time: time + idx * PIPE_SPAWN_DELAY };
};

//Parse the CSV content into pipe data
const parsePipeData = (csvContent: string): readonly PipeData[] => {
    const lines = linesOData(csvContent);
    return lines.map(dataPiper);
};

/**
 * Creates a new pipe from pipe data
 * @param pipeData The data for the pipe
 * @param id Unique identifier for the pipe
 * @returns New pipe object
 */
const createPipe = (pipeData: PipeData, id: number): Pipe => ({
    //start at the right edge of the screen
    x: Viewport.CANVAS_WIDTH,
    //position of GAP Y
    gapY: pipeData.gap_y,
    //Height of the gap
    gapHeight: pipeData.gap_height,
    //time for spawning of pipes
    time: pipeData.time,
    //pipe's id
    id,
});

/** Updates state with next random seed */
const randoSeedUpdtr = (state: State): { nxtSeed: number } => {
    //Generate next seed from RNG
    const { nxtSeed } = RNG.randoSeed(state.randomSeed);
    //return the next seed
    return { nxtSeed: nxtSeed };
};

/**
 * Moves all power-ups to the left by LEPIPER (with speed multiplier) and removes those off-screen.
 * @param powerUps Array of current power-ups
 * @param state Current game state to get speed multiplier
 * @returns Updated array of power-ups
 */
function powerUpMovers(
    // Move power-ups based on game state
    powerUps: readonly PowerUp[],
    //the game state
    state: State,
): readonly PowerUp[] {
    return (
        powerUps
            .map(pow => ({
                ...pow,
                //multiple by factorOspeed move left by the LEPIPER pixels
                x: pow.x - Constants.LEPIPER * factorOSpeed(state),
            }))
            //remove the powerups that have moved off the left edge
            .filter(pow => pow.x > -20)
    );
}

/**
 * Spawns new pipes based on current time
 * @param state Current game state
 * @returns Updated state with new pipes spawned
 */
const pipoSpawner = (state: State): State =>
    //check is there more pipe to be spawened
    state.nextPipeIndex >= state.pipeData.length
        ? state
        : //if not yet the time for the next pipe then do nothing
          state.time <
            state.pipeData[state.nextPipeIndex].time +
                Constants.PIPE_SPAWN_DELAY
          ? state
          : //Else just spawn a new pipe with the possibility of a power-up
            (() => {
                const newPipe = createPipe(
                    state.pipeData[state.nextPipeIndex],
                    state.nextPipeIndex,
                );
                //Update the random seed and power-ups
                const { nxtSeed } = randoSeedUpdtr(state);
                //Handle power up spawning logic
                const { powerUps, nextSeed: finalSeed } = pwrHandler(
                    state,
                    nxtSeed,
                );

                //return updated state with a new pipe and maybe a power-up
                return {
                    ...state,
                    pipes: [...state.pipes, newPipe],
                    nextPipeIndex: state.nextPipeIndex + 1,
                    powerUps,
                    nextPowerUpId: state.nextPowerUpId + 1,
                    randomSeed: finalSeed,
                };
            })();

//Calculate the pos diff between the n-th power up
export const powerUpsPos = (
    n: number,
    state: State,
): { dx: number; dy: number } | null => {
    const pow = state.powerUps[n];
    //return null if no power-up at the index
    if (!pow) return null;

    //Calculate the distance between the birb and the power-up
    const dx = pow.x - state.birb.x;
    const dy = pow.y - state.birb.y;
    return { dx, dy };
};

//return the number of frames for a speed pow up effect
const speedCalculation = (frames: number): number => {
    return frames;
};
/**
 * Applies the effect of a power-up to the game state.
 * @param pow The power-up to apply
 * @param s The game state to modify
 * @returns The modified game state
 */
const effectApplier = (pow: PowerUp, s: State): State => {
    switch (pow.typoPowerUps) {
        case "invincibility":
            //grant invincibility frames to the bird (power up)
            return {
                ...s,
                birb: {
                    ...s.birb,
                    invincibilityFrames: Constants.TIME_OF_INVINCIBILITY,
                },
            };
        case "i am speed":
            //grant the turbo effect to the bird (speed timer)
            return {
                ...s,
                speedTimer: speedCalculation(Constants.TURBO_DURATION),
            };
        default:
            //else do nothing if its unknown
            return s;
    }
};

//Check if a power-up has been collected
const powerUpCollected = (idx: number, state: State): boolean => {
    const pos = powerUpsPos(idx, state);
    //Check if the power-up is within the collection range
    return pos !== null && pureMathAbs(pos.dx) < 20 && pureMathAbs(pos.dy) < 20;
};

//Applies all collected power-ups effect to the state
const applierOPower = (
    //arr of collected pows
    collected: typeof state.powerUps,
    //curr game state
    state: State,
): State => {
    //reduce over collected pow-ups applying each effect
    return collected.reduce((s, pow) => effectApplier(pow, s), state);
};

//Partitions power-ups into collected and remaining
const powPartitioner = (powerUps: typeof state.powerUps, state: State) => {
    return powerUps.reduce(
        (acc, pow, idx) => {
            if (powerUpCollected(idx, state)) {
                //add power ups to collected if the bird is close enough
                return { ...acc, collected: [...acc.collected, pow] };
            }
            //keep it in remaining if well it isnt collected
            return { ...acc, remaining: [...acc.remaining, pow] };
        },
        {
            collected: [] as typeof state.powerUps,
            remaining: [] as typeof state.powerUps,
        },
    );
};

//applies the effect of the power up and update the state
export const collectPowerUps = (state: State): State => {
    //partition power ups into collected and remaining
    const { collected, remaining } = powPartitioner(state.powerUps, state);
    //apply the effect of the power ups
    const updatedState = applierOPower(collected, state);
    //update the state with remaining power-ups
    return { ...updatedState, powerUps: remaining };
};

/**
 * Applies gravity and updates bird position
 * @param bird Current bird state
 * @returns Updated bird state
 */
const updateBirdPhysics = (birb: Birb): Birb => ({
    ...birb,
    //apply gravity to the velocity
    veloY: birb.veloY + Constants.LEGRAV,
    //move birb by velocity
    y: birb.y + birb.veloY,
    // Decrease invincibility frames if active
    invincibilityFrames: pureMathMax(0, birb.invincibilityFrames - 1),
});

/**
 * Makes the bird flap (jump upward)
 * @param bird Current bird state
 * @returns Updated bird state with flap velocity
 */
const flapBird = (birb: Birb): Birb => ({
    ...birb,
    //set velocity to wing strength (neg is up fyi)
    veloY: Constants.WING_STR,
});

/**
 * Generates random bounce velocity
 * @returns Random velocity between min and max bounce values
 */
const randomBounceVelocity = (
    seed: number,
): { val: number; nxtSeed: number } => {
    //get random value and next seed
    const { val, nxtSeed } = RNG.randoSeed(seed);
    const range = Constants.BOUNCE_VELOCITY_MAX - Constants.BOUNCE_VELOCITY_MIN;
    //Scale random value to bounce velocity range
    const bounceVal = val * range + Constants.BOUNCE_VELOCITY_MIN;

    return { val: bounceVal, nxtSeed };
};

/**
 * Bounces bird with random velocity (used when hitting obstacles)
 * @param bird Current bird state
 * @returns Updated bird state with bounce velocity
 */
const bounceBird = (
    bird: Birb,
    seed: number,
    topBoundHittr: boolean = false,
): { birb: Birb; nextSeed: number } => {
    const { val, nxtSeed } = randomBounceVelocity(seed);
    const [birbTop] = getBirdBounds(bird);
    const topHitter = birbTop <= 0;
    const veloBouncer = topHitter ? pureMathAbs(val) : -pureMathAbs(val);
    return {
        birb: {
            ...bird,
            //set new velocity
            veloY: veloBouncer,
        },
        //return next seed
        nextSeed: nxtSeed,
    };
};

//check if the bird overlaps with a pipe horizontally
const birbOverlapper = (birb: Birb, pipers: Pipe): boolean => {
    // Check if the front of the bird is past the left edge of the pipe
    const frontCollider = birb.x + Birb.WIDTH / 2 >= pipers.x;
    // Check if the back of the bird is before the right edge of the pipe
    const backCollider =
        birb.x - Birb.WIDTH / 2 <= pipers.x + Constants.PIPE_WIDTH;
    // Bird overlaps pipe horizontally if both conditions are true
    return frontCollider && backCollider;
};

// Gets the top and bottom gap positions for a pipe
const piperChecker = (pipers: Pipe): [number, number] => {
    // Calculate gap boundaries using gapCalc helper
    const [gapTop, gapBottom] = gapCalc(pipers);
    // Return top and bottom pixel pos of the gap
    return [gapTop, gapBottom];
};

// Calculates the gap size for a pipe, applying multiplier and minimum constraints
const gapMultiplierCalc = (piper: Pipe): number => {
    // Multiply gap height by multiplier, ensure it's at least the minimum gap
    return pureMathMax(
        piper.gapHeight * Constants.PIPE_GAP_MULTIPLIER,
        Constants.MIN_PIPE_GAP,
    );
};

/**
 * Calculates enhanced gap size with multiplier and minimum constraints
 * @param pipe Pipe object with gap data
 * @returns Tuple of [gapTop, gapBottom] pixel coordinates
 */
const gapCalc = (pipe: Pipe): [number, number] => {
    // Canvas height in pixels
    const canHeight = Viewport.CANVAS_HEIGHT;
    // Raw gap height in pixels
    const baseGapHeight = pipe.gapHeight * canHeight;

    // Apply gap multiplier and ensure minimum gap size
    const leGapper = gapMultiplierCalc(pipe);

    // Half the gap size
    const halfGap = leGapper / 2;
    // Center of gap in pixels
    const gapCenterY = pipe.gapY * canHeight;

    // Ensure gap doesn't go outside canvas boundaries
    const minCenterY = halfGap;
    const maxCenterY = canHeight - halfGap;
    // First clamp to minimum, then clamp to maximum
    const centYClamped =
        gapCenterY < minCenterY
            ? minCenterY
            : gapCenterY > maxCenterY
              ? maxCenterY
              : gapCenterY;

    // Calculate top and bottom pixel positions of the gap
    const gapTop = centYClamped - halfGap;
    const gapBottom = centYClamped + halfGap;

    return [gapTop, gapBottom];
};

// Gets the top and bottom pixel positions of the bird
const getBirdBounds = (birb: Birb): [number, number] => {
    // Top of bird is y minus half its height
    const birbTop = birb.y - Birb.HEIGHT / 2;
    // Bottom of bird is y plus half its height
    const birbBottom = birb.y + Birb.HEIGHT / 2;
    return [birbTop, birbBottom];
};

// Checks if bird hits the top or bottom of the screen
const checkBoundaryCollision = (bird: Birb): boolean => {
    const [birbTop, birbBottom] = getBirdBounds(bird);

    // True if bird is above top edge or below bottom edge
    const hitTop = birbTop <= 0;
    const hitBottom = birbBottom >= Viewport.CANVAS_HEIGHT;

    return hitTop || hitBottom;
};

// Checks if bird collides with a pipe (not in the gap)
const piperCollision = (birb: Birb, pipers: Pipe): boolean => {
    // First check horizontal overlap
    const overlap = birbOverlapper(birb, pipers);
    // No overlap === no collision
    if (!overlap) return false;
    //gap boundary calc (well the boring stuff)
    const [gapTop, gapBottom] = piperChecker(pipers);
    // Check if bird hits top or bottom pipe
    const [birbTop, birbBottom] = getBirdBounds(birb);
    // Collision if bird is above gapTop or below gapBottom
    return birbTop < gapTop || birbBottom > gapBottom;
};

/**
 * Checks if bird hits screen boundaries (top or bottom)
 * @param bird Current bird state
 * @returns true if bird hits boundaries
 */
const birbBoundaryCollision = (birb: Birb): boolean => {
    //use helper function for boundary checking
    return checkBoundaryCollision(birb);
};

/**
 * Checks if bird is currently invincible (after collision)
 * @param birb Current bird state
 * @param state Full game state
 * @returns true if bird is invincible
 */
const invincibilityBirb = (birb: Birb, state: State): boolean => {
    // Invincibility active if frames > 0
    return state.birb.invincibilityFrames > 0;
};

/**
 * Calculate the no of lives post injury of the birb
 * @param state curr game state
 * @returns updated lives count
 */
const birbInjury = (state: State) => {
    //if its injured remove 1 life
    return state.lives - 1;
};

/**
 * Birb collision handler with pipes and boundaries
 * @param state curr game state
 * @returns Updated state after accident handling
 */
const accidentHandler = (state: State): State => {
    // Ignore collision if invincible (well the invincible helper is for this mainly)
    if (invincibilityBirb(state.birb, state)) return state;

    //check if birb has collided with any of the pipes
    const collisionOPipe = state.pipes.some(pipe =>
        piperCollision(state.birb, pipe),
    );
    // Check if bird hit top or bottom boundary
    const leBound = birbBoundaryCollision(state.birb);

    // No collision then just return unchanged state
    if (!collisionOPipe && !leBound) return state;

    const [birbTop] = getBirdBounds(state.birb);
    const topBoundHittr = leBound && birbTop <= 0;

    // Bounce bird back and get new random seed for deterministic behavior
    const { birb: bouncedBird, nextSeed } = bounceBird(
        state.birb,
        state.randomSeed,
        topBoundHittr,
    );
    // Reduce life of the birb after collision
    const updtdLife = birbInjury(state);

    // Return updated state after accident
    return {
        ...state,
        birb: {
            // Apply bounced bird state
            ...bouncedBird,
            // Add invincibility after ze damanged
            invincibilityFrames: Constants.DAMAGED_INVINCIBILITY,
        },
        //update the live, end the game if no live and update the random seed
        lives: updtdLife,
        gameEnd: updtdLife <= 0,
        randomSeed: nextSeed,
    };
};

/**
 * Filters pipes that the bird has completely passed
 * @param pipers All active pipes
 * @param birb Bird state
 * @param pipePassed Last pipe ID scored
 * @returns Array of pipes that bird has passed and not scored yet
 */
const passedPipers = (
    pipers: readonly Pipe[],
    birb: Birb,
    pipePassed: number,
): readonly Pipe[] => {
    return pipers.filter(
        pipe =>
            // Bird passed completely through pipe
            birb.x > pipe.x + Constants.PIPE_WIDTH &&
            // Haven't scored this pipe yet
            pipe.id > pipePassed,
    );
};

/**
 * Gets the last pipe in the list
 */
const lastPiperFinder = (pipers: readonly Pipe[]): Pipe | undefined => {
    //to return the last pipe
    return pipers[pipers.length - 1];
};

/**
 * Returns ID of last pipe or 0 if no pipes
 */
const lastPiperId = (pipers: readonly Pipe[]): number => {
    const lastPipe = lastPiperFinder(pipers);
    //if pipe is there then return its id else return 0
    return lastPipe ? lastPipe.id : 0;
};

/**
 * Calculates score from passed pipes
 */
const scoreCalc = (pipers: readonly Pipe[]): number => {
    //score is based on amount of pipes passed so just return the score
    return pipers.length;
};

/**
 * Updates score based on pipes the bird has passed
 * @param state Current game state
 * @returns Updated state with new score
 */
const updateScore = (state: State): State =>
    (() => {
        // Get pipes passed since last scoring
        const passedPipes = passedPipers(
            state.pipes,
            state.birb,
            state.lastScoredPipeId,
        );

        // If we have pipes that were passed, update score
        return passedPipes.length > 0
            ? {
                  ...state,
                  score: state.score + scoreCalc(passedPipes),
                  lastScoredPipeId: lastPiperId(passedPipes),
              }
            : // Otherwise return unchanged state
              state;
    })();

/**
 * Checks if all pipes are spawned
 */
const spawnOPipes = (state: State): boolean => {
    // well no pipes left, too bad
    return state.nextPipeIndex >= state.pipeData.length;
};

/**
 * Checks if all active pipes have been passed
 */
const passedOPipes = (state: State): boolean => {
    //there is null pipe on ze screen
    return state.pipes.length === 0;
};

/**
 * Marks game as won and ended
 */
const gameOCond = (state: State): State => ({
    ...state,
    gameWon: true,
    gameEnd: true,
});
/**
 * Checks if game is still active
 */
const soGameActive = (state: State): boolean => {
    return !state.gameEnd && !state.gameWon;
};

/**
 * Checks if win condition is met (all pipes cleared and game active)
 */
const winAlready = (state: State): boolean => {
    return spawnOPipes(state) && passedOPipes(state) && soGameActive(state);
};

/**
 * Checks if game is won (all pipes passed)
 * @param state Current game state
 * @returns Updated state with gameWon flag
 */
const condWinChckr = (state: State): State => {
    return winAlready(state) ? gameOCond(state) : state;
};

/**
 * Utility for functional composition (piping multiple functions) (4 piping man)
 */
const lePiping =
    <p>(...arr: Array<(argmnt: p) => p>) =>
    (argmnt: p): p => {
        return arr.reduce((acc, fn) => fn(acc), argmnt);
    };

/**
 * Calculates new time based on tick rate
 */
const timeCalculation = (state: State): number => {
    return state.time + Constants.TICK_RATE_MS / 1000;
};

/**
 * Speed multiplier if speed power-up active
 */
const factorOSpeed = (state: State): number => {
    return state.speedTimer > 0 ? Constants.SPEEDUP_MULTIPLIER : 1;
};

/**
 * Updates speed timer (decrease or 0)
 */
const timerOSpeed = (state: State): number => {
    return state.speedTimer > 0 ? state.speedTimer - 1 : 0;
};

/**
 * Applies speed timer update to state
 */
const speedTimerUpdtr = (state: State): State => {
    return {
        ...state,
        speedTimer: timerOSpeed(state),
    };
};

/**
 * Advances time in state
 */
const timeAdvncr = (state: State): State => {
    return {
        ...state,
        time: timeCalculation(state),
    };
};

/**
 * Moves pipes to the left (game scrolling)
 */
const piperMvr = (state: State): State => {
    return {
        ...state,
        pipes: state.pipes
            .map(pipe => ({
                ...pipe,
                x: pipe.x - Constants.LEPIPER * factorOSpeed(state),
            }))
            .filter(pipe => pipe.x > -Constants.PIPE_WIDTH),
    };
};

/**
 * Determines if current frame should record ghost position
 */
const ghostFrameRecorder = (fps: number): boolean => {
    return fps % Constants.GHOST_REC_INTERVAL === 0;
};

/**
 * Creates a position object for ghost recording
 */
const ghostBirbPos = (state: State): Pos => {
    return {
        x: state.birb.x,
        y: state.birb.y,
        frame: state.frame,
    };
};

/**
 * Adds new ghost position to recording
 */
const ghostBirbRec = (currRec: readonly Pos[], newPos: Pos): readonly Pos[] => {
    return [...currRec, newPos];
};

/**
 * Records the current bird position for ghost replay
 */
const recordGhostPosition = (state: State): State => {
    // Only record every few frames to optimize
    if (!ghostFrameRecorder(state.frame)) {
        //skip if the frame isnt for recording
        return state;
    }

    const ghostPos = ghostBirbPos(state);
    const newRec = ghostBirbRec(state.currRec, ghostPos);

    return {
        ...state,
        currRec: newRec,
    };
};

/**
 * Increment frame counter
 */
const frameAddr = (state: State): number => {
    return state.frame + 1;
};

/**
 * Update frame counter
 */
const frameCountUpdtr = (state: State): State => ({
    ...state,
    frame: frameAddr(state),
});

/**
 * Main game ticker (updates state every tick)
 */
const ticker = (state: State): State =>
    state.gameEnd
        ? state
        : lePiping(
              s => ({ ...s, birb: updateBirdPhysics(s.birb) }),
              s => ({ ...s, powerUps: powerUpMovers(s.powerUps, s) }),
              timeAdvncr,
              piperMvr,
              speedTimerUpdtr,
              frameCountUpdtr,
              pipoSpawner,
              updateScore,
              accidentHandler,
              collectPowerUps,
              recordGhostPosition,
              condWinChckr,
          )(state);

// ============================================================================
// RENDERING (SIDE EFFECTS)
// ============================================================================

/**
 * Brings an SVG element to the foreground.
 * @param elem SVG element to bring to the foreground
 */
const leForegroundBringer = (elem: SVGElement): void => {
    // Re-append to the same parent so it becomes the last child
    elem.parentNode?.appendChild(elem);
};

/**
 * Displays a SVG element on the canvas. Brings to foreground.
 * @param elem SVG element to display
 */
const elemShower = (elem: SVGElement): void => {
    // Set SVG visibility attribute to visible
    elem.setAttribute("visibility", "visible");
    // Move it to the end of its parent children to draw above others
    leForegroundBringer(elem);
};

/**
 * Hides a SVG element on the canvas.
 * @param elem SVG element to hide
 */
const hide = (elem: SVGElement): void => {
    elem.setAttribute("visibility", "hidden");
};

const { WIDTH, HEIGHT } = Birb;

const { PIPE_WIDTH, GHOST_OPACITY, GHOST_REC_INTERVAL } = Constants;

const { CANVAS_HEIGHT, CANVAS_WIDTH } = Viewport;

const verHor = { x: WIDTH / 2, y: HEIGHT / 2 };

/**
 * To use helper to calculate the gaps of the pipes (its just helper)
 * @param pipe the gap of the pipe
 * @returns the calculated gaps
 */
const pipeGapperCalc = (pipe: Pipe): [number, number] => {
    //use helper to calculate the bottom and top gaps
    const [gapTop, gapBottom] = gapCalc(pipe);
    //return the calculated gaps
    return [gapTop, gapBottom];
};

/**
 * Calculates the position for the subtitle text
 * @returns [x, y] coordinates for the subtitle text
 */
const subTxtCalc = (): [number, number] => {
    // Calculate the x position
    const x = CANVAS_WIDTH / 2;
    // Calculate the y position
    const y = CANVAS_HEIGHT / 2 - 20;
    //return the calculated positions
    return [x, y];
};

/**
 * Calculate the pos for the restart text
 * @returns  the position of the restart text
 */
const restrtTxt = (): [number, number] => {
    //calculate the x position
    const resX = CANVAS_WIDTH / 2;
    //calculate the y position
    const resY = CANVAS_HEIGHT / 2 - 40;
    //return the calculated positions
    return [resX, resY];
};

interface RenderOptions {
    opacity?: number;
    filter?: string;
}

/**
 * Creates an SVG element with the given properties.
 *
 * See https://developer.mozilla.org/en-US/docs/Web/SVG/Element for valid
 * element names and properties.
 *
 * @param namespace Namespace of the SVG element
 * @param name SVGElement name
 * @param props Properties to set on the SVG element
 * @returns SVG element
 */
const createSvgElement = (
    namespace: string | null,
    name: string,
    props: Record<string, string> = {},
): SVGElement => {
    // Create the SVG element
    const elem = document.createElementNS(namespace, name) as SVGElement;
    // Set the attributes functionally using reduce for side effects
    Object.entries(props).reduce((element, [k, v]) => {
        element.setAttribute(k, v);
        return element;
    }, elem);
    //return the element
    return elem;
};

// its impure (idk how to make it pure)
const traderBtn = (): HTMLButtonElement => {
    // Create or return a persistent trade button in the DOM
    const leButtone = document.getElementById(
        // ID used for the trader button
        "trdr-btn",
        // Cast the queried element to button or null
    ) as HTMLButtonElement | null;
    // If it already exists, reuse it (avoid duplicates)
    if (leButtone) return leButtone;

    // Create a new HTML button (outside SVG)
    const tb = document.createElement("button");
    // Assign the fixed id so it can be found next time
    tb.id = "trdr-btn";
    tb.textContent = `Trade ${extraConst.extraLifeCost} for 1 life ? (Press T to trade)`;
    tb.style.position = "absolute";
    tb.style.right = "8px";
    tb.style.top = "8px";
    // Insert into the document so it becomes visible and clickable
    document.body.appendChild(tb);

    // remove DOM-based setTimeout cooldown here — cooldown handled in streams
    // Return the created button instance
    return tb;
};

/**
 * Renders a bird image to the SVG canvas at specified coordinates
 * @param svg The SVG element to render to
 * @param x X position for the bird
 * @param y Y position for the bird
 * @param options Rendering options with opacity and filter
 * @returns The created bird SVG element
 */
const renderBirb = (
    svg: SVGSVGElement,
    x: number,
    y: number,
    { opacity = 1.0, filter }: RenderOptions = {},
): SVGElement => {
    //Create the bird image element with all the visual properties
    const bird = createSvgElement(svg.namespaceURI, "image", {
        //mark as game element for easy cleanup
        class: "game-element",
        //link to the bird image asset
        href: "assets/birb.png",
        //center the bird horizontally on x position
        x: `${x - verHor.x}`,
        //center the bird vertically on y position
        y: `${y - verHor.y}`,
        //set bird width from constants
        width: `${WIDTH}`,
        //set bird height from constants
        height: `${HEIGHT}`,
        //apply opacity (used for invincibility flashing)
        opacity: `${opacity}`,
        //conditionally apply filter if provided (used for ghost hue shift)
        ...(filter ? { filter } : {}),
    });
    //add the bird to the SVG canvas
    svg.appendChild(bird);
    //return the created element
    return bird;
};

/**
 * Creates the top pipe element for a given pipe
 * @param svg SVG element to render to
 * @param piper Pipe data with gap information
 * @returns The top pipe SVG rectangle
 */
const abvPipeCrtr = (svg: SVGElement, piper: Pipe): SVGElement => {
    //get the gap boundaries for this pipe
    const [gapTop, gapBottom] = pipeGapperCalc(piper);
    //Above Piper - create rectangle from top of screen to gap start
    return createSvgElement(svg.namespaceURI, "rect", {
        //mark as game element for cleanup
        class: "game-element",
        //pipe x position
        x: piper.x.toString(),
        //start from very top of screen
        y: "0",
        //standard pipe width
        width: `${PIPE_WIDTH}`,
        //height goes from top to where gap starts
        height: `${gapTop}`,
        //green pipe color
        fill: "green",
    });
};

/**
 * Creates the bottom pipe element for a given pipe
 * @param svg SVG element to render to
 * @param piper Pipe data with gap information
 * @returns The bottom pipe SVG rectangle
 */
const btmPiperCrtr = (svg: SVGElement, piper: Pipe): SVGElement => {
    //get the gap boundaries for this pipe
    const [gapTop, gapBottom] = pipeGapperCalc(piper);
    //Bottom Piper - create rectangle from gap end to bottom of screen
    return createSvgElement(svg.namespaceURI, "rect", {
        //mark as game element for cleanup
        class: "game-element",
        //pipe x position
        x: piper.x.toString(),
        //start where the gap ends
        y: `${gapBottom}`,
        //standard pipe width
        width: `${PIPE_WIDTH}`,
        //height goes from gap end to bottom of canvas
        height: `${CANVAS_HEIGHT - gapBottom}`,
        //green pipe color
        fill: "green",
    });
};

/**
 * Displays the main win message when game is completed
 * @param svg SVG element to render to
 * @param state Current game state with score
 */
const winDisplayer = (svg: SVGElement, state: State): void => {
    //create the main win text element
    const winText = createSvgElement(svg.namespaceURI, "text", {
        //mark as game element for cleanup
        class: "game-element",
        //center horizontally
        x: "50%",
        //center vertically
        y: "50%",
        //center text baseline
        "dominant-baseline": "middle",
        //center text anchor
        "text-anchor": "middle",
        //black text color
        fill: "black",
        //large font for main message
        "font-size": "24px",
    });
    //set the win message with current score
    winText.textContent = `You Win! Score: ${state.score}`;
    //add the text to the canvas
    svg.appendChild(winText);
};

/**
 * Displays the subtitle win message below the main win text
 * @param svg SVG element to render to
 * @param s Current game state with final score
 */
const winSubTxt = (svg: SVGElement, s: State): void => {
    //get calculated position for subtitle
    const [x, y] = subTxtCalc();
    //create the subtitle text element
    const winSubtext = createSvgElement(svg.namespaceURI, "text", {
        //mark as game element for cleanup
        class: "game-element",
        //use calculated x position
        x: `${x}`,
        //use calculated y position
        y: `${y}`,
        //center the text
        "text-anchor": "middle",
        //green color for subtitle
        fill: "green",
        //smaller font for subtitle
        "font-size": "16",
    });
    //set the completion message with final score
    winSubtext.textContent = `You completed all pipes! Final Score: ${s.score}`;
    //add the subtitle to the canvas
    svg.appendChild(winSubtext);
};

/**
 * Renders both top and bottom pipe elements for a single pipe
 * @param svg SVG element to render to
 * @param piper Pipe data to render
 * @returns Array containing both pipe elements [top, bottom]
 */
const piperRenderer = (svg: SVGSVGElement, piper: Pipe): SVGElement[] => {
    //create the top pipe element
    const piperAbv = abvPipeCrtr(svg, piper);
    //create the bottom pipe element
    const piperBtm = btmPiperCrtr(svg, piper);
    //add top pipe to canvas
    svg.appendChild(piperAbv);
    //add bottom pipe to canvas
    svg.appendChild(piperBtm);
    //return both elements for reference
    return [piperAbv, piperBtm];
};

/**
 * Updates the score and lives display in the UI
 * @param sText Score text element (can be null)
 * @param lText Lives text element (can be null)
 * @param state Current game state with score and lives
 */
const scoreRenderer = (
    sText: HTMLElement | null,
    lText: HTMLElement | null,
    state: State,
): void => {
    //update score display if element exists
    if (sText) sText.textContent = `${state.score}`;
    //update lives display if element exists
    if (lText) lText.textContent = `${state.lives}`;
};

/**
 * Renders a power-up with appropriate color and label
 * @param svg SVG element to render to
 * @param powerUp Power-up data with type and position
 */
const powUpRndrer = (svg: SVGElement, powerUp: PowerUp): void => {
    //choose color based on power-up type (gold for invincibility, cyan for speed)
    const color = powerUp.typoPowerUps === "invincibility" ? "gold" : "cyan";

    //create the circular power-up background
    const circle = createSvgElement(svg.namespaceURI, "circle", {
        //mark as game element for cleanup
        class: "game-element",
        //center x position
        cx: `${powerUp.x}`,
        //center y position
        cy: `${powerUp.y}`,
        //small circle radius
        r: "8",
        //color based on power-up type
        fill: color,
        //slightly transparent
        opacity: "0.9",
    });

    //create the text label on the power-up
    const txt = createSvgElement(svg.namespaceURI, "text", {
        //mark as game element for cleanup
        class: "game-element",
        //center text on power-up x
        x: `${powerUp.x}`,
        //slightly below center for better positioning
        y: `${powerUp.y + 4}`,
        //center the text
        "text-anchor": "middle",
        //small font for label
        "font-size": "8",
        //black text for visibility
        fill: "black",
    });
    //set label text based on power-up type
    txt.textContent = powerUp.typoPowerUps === "invincibility" ? "INV" : "SPE";

    //add circle to canvas
    svg.appendChild(circle);
    //add text label to canvas
    svg.appendChild(txt);
};

// Helper function to find ghost position for current frame
const ghostPosFinder = (
    prevRec: readonly Pos[],
    currFrame: number,
): Pos | undefined => {
    // First try to find exact frame match
    const frameMatcher = prevRec.find(pos => pos.frame === currFrame);
    //if exact frame found, return it immediately
    if (frameMatcher) return frameMatcher;

    // Then find the closest frame within the recording interval
    return prevRec.find(
        pos =>
            //check if position has a frame number recorded
            pos.frame &&
            //find frame within the ghost recording interval
            pureMathAbs(pos.frame - currFrame) < GHOST_REC_INTERVAL,
    );
};

// Helper function to render ghost bird
const ghostBirbRenderer = (svg: SVGSVGElement, ghostPos: Pos): void => {
    //render the ghost bird with reduced opacity and color shift
    renderBirb(svg, ghostPos.x, ghostPos.y, {
        //make it semi-transparent for ghost effect
        opacity: GHOST_OPACITY,
        //shift hue to make it look different from main bird
        filter: "hue-rotate(180deg)",
    });
};

// Helper function to handle all ghost rendering logic
const ghostRenderer = (svg: SVGSVGElement, s: State): void => {
    //only render ghost if we have previous recording data
    if (s.prevRec.length > 0) {
        //find the ghost position for current frame
        const ghostPos = ghostPosFinder(s.prevRec, s.frame);
        //if we found a valid ghost position, render it
        if (ghostPos) {
            //render the ghost bird at found position
            ghostBirbRenderer(svg, ghostPos);
        }
    }
};

/**
 * Displays the restart instruction text when game ends
 * @param svg SVG element to render to
 */
const reStrt = (svg: SVGElement) => {
    //get calculated position for restart text
    const [resX, resY] = restrtTxt();
    //create the restart instruction text
    const restartText = createSvgElement(svg.namespaceURI, "text", {
        //mark as game element for cleanup
        class: "game-element",
        //use calculated x position
        x: `${resX}`,
        //use calculated y position
        y: `${resY}`,
        //center the text
        "text-anchor": "middle",
        //white text for visibility on dark background
        fill: "white",
        //medium sized font
        "font-size": "14",
    });
    //set the instruction text
    restartText.textContent = "Click To Play Again";
    //add the text to canvas
    svg.appendChild(restartText);
};

/**
 * Clears all game elements from the SVG canvas for clean redraw
 * @param svg SVG canvas to clean
 */
const gameCleaner = (svg: SVGSVGElement): void => {
    //find all elements marked with game-element class
    const gameElements = svg.querySelectorAll(".game-element");
    //remove each game element from the canvas using functional approach
    Array.from(gameElements).reduce((_, elem) => {
        svg.removeChild(elem);
        return null;
    }, null);
};

const render = (): ((s: State) => void) => {
    // Canvas elements
    const gameOver = document.querySelector("#gameOver") as SVGElement;
    const container = document.querySelector("#main") as HTMLElement;

    // Text fields
    const livesText = document.querySelector("#livesText") as HTMLElement;
    const scoreText = document.querySelector("#scoreText") as HTMLElement;

    const svg = document.querySelector("#svgCanvas") as SVGSVGElement;

    svg.setAttribute("viewBox", `0 0 ${CANVAS_WIDTH} ${CANVAS_HEIGHT}`);
    /**
     * Renders the current state to the canvas.
     * Functional approach: clear and redraw all game elements each frame
     *
     * @param s Current state
     */
    return (s: State) => {
        // Update score and lives display using helper
        scoreRenderer(scoreText, livesText, s);

        // Clear canvas using helper
        gameCleaner(svg);

        // Render ghost bird from previous run using helper
        ghostRenderer(svg, s);

        // Add current bird at its position using helper
        renderBirb(svg, s.birb.x, s.birb.y, {
            opacity: s.birb.invincibilityFrames > 0 ? 0.5 : 1.0,
        });

        // Render all pipes using functional approach
        s.pipes.reduce((acc, pipe) => {
            piperRenderer(svg, pipe);
            return acc;
        }, undefined as void);

        // Render power-ups using functional approach
        s.powerUps.reduce((acc, pu) => {
            powUpRndrer(svg, pu);
            return acc;
        }, undefined as void);

        // Show game over or game won message
        if (s.gameEnd) {
            if (s.gameWon) {
                // Use win display helpers
                winDisplayer(svg, s);
                winSubTxt(svg, s);
            } else {
                // Show game over message
                if (gameOver) elemShower(gameOver);
            }

            // Show restart instruction using helper
            reStrt(svg);
        } else {
            // Hide game over element during gameplay
            if (gameOver) hide(gameOver);
        }
    };
};

// ============================================================================
// OBSERVABLE STREAMS
// ============================================================================

/**
 * Creates an Observable that filters keyboard events for a specific key
 * @param propCode The key code to filter for (Space or KeyT)
 * @returns Observable stream of filtered keyboard events
 */
const keyStreamer = (propCode: Key) =>
    //listen for keydown events on the document
    fromEvent<KeyboardEvent>(document, "keydown").pipe(
        //filter to only pass through events matching the specified key
        filter(k => (k.code ?? k.key) === propCode),
    );

/**
 * Creates and merges all input streams for the game
 * @param tradeBtn The trade button element for click events
 * @returns Merged Observable of all possible game actions
 */
const createActionStreams = (tradeBtn: HTMLElement) => {
    //create base keyboard event stream
    const key$ = fromEvent<KeyboardEvent>(document, "keydown");
    //create mouse click event stream for restart
    const click$ = fromEvent<MouseEvent>(document.body, "mousedown");
    //create timer tick stream for game loop at specified rate
    const tick$ = interval(Constants.TICK_RATE_MS);

    //space key creates flap actions using keyStreamer helper
    const flap$ = keyStreamer("Space").pipe(map(() => "flap" as const));
    //mouse clicks create restart actions
    const restart$ = click$.pipe(map(() => "restart" as const));

    //trade button clicks with throttling to prevent spam
    const tradeClick$ = fromEvent(tradeBtn, "click").pipe(
        //prevent rapid clicking using cooldown period
        throttleTime(extraConst.tradeCooldown),
        //map click events to trade actions
        map(() => "trade" as const),
    );

    //T key presses for trading with throttling
    const tradeKey$ = keyStreamer("KeyT").pipe(
        //prevent rapid key presses using cooldown period
        throttleTime(extraConst.tradeCooldown),
        //map key events to trade actions
        map(() => "trade" as const),
    );

    //merge all action streams into one unified stream
    return merge(
        //game tick for animation and physics
        tick$.pipe(map(() => "tick" as const)),
        //bird flapping action
        flap$,
        //trading via button click
        tradeClick$,
        //trading via keyboard
        tradeKey$,
        //restart game action
        restart$,
    );
};

/**
 * State reducer that processes actions and returns new game state
 * @param state Current game state
 * @param action The action to process (tick, flap, restart, trade)
 * @returns Updated game state based on the action
 */
const reducerOState = (
    state: State,
    action: "tick" | "flap" | "restart" | "trade",
): State => {
    //switch on action type to determine what to do
    switch (action) {
        case "tick":
            //advance game by one frame using ticker function
            return ticker(state);
        case "flap":
            //only flap if game is still running
            return state.gameEnd
                ? //if game ended, do nothing
                  state
                : //otherwise apply flap to the bird
                  { ...state, birb: flapBird(state.birb) };
        case "restart":
            //only restart if game has actually ended
            return state.gameEnd
                ? {
                      //reset to initial state but keep some data
                      ...initialState,
                      //preserve pipe data from CSV
                      pipeData: state.pipeData,
                      // Save current bird positions as ghost for next game
                      prevRec: state.currRec,
                      // Reset current record for new game
                      currRec: [],
                  }
                : //if game is still running, ignore restart
                  state;
        case "trade":
            //attempt to trade score for life using helper
            return tradeApplier(state);
        default:
            //fallback for unknown actions (shouldn't happen)
            return state;
    }
};

/**
 * Creates the main game state Observable stream
 * @param csvContents Raw CSV data for pipe generation
 * @returns Observable stream of game states updated by user actions
 */
export const state$ = (csvContents: string): Observable<State> => {
    //create the trade button for UI interaction
    const tradeBtn = traderBtn();
    //parse the CSV data into usable pipe information
    const pipeData = parsePipeData(csvContents);

    //create initial game state with parsed pipe data
    const gameStateInitial: State = {
        //start with base initial state
        ...initialState,
        //add the parsed pipe data
        pipeData,
    };

    //create the merged stream of all user inputs
    const input$ = createActionStreams(tradeBtn);

    //use scan to accumulate state changes over time
    return input$.pipe(scan(reducerOState, gameStateInitial));
};

// ============================================================================
// MAIN BOOTSTRAP
// ============================================================================

// The following simply runs your main function on window load.  Make sure to leave it in place.
// You should not need to change this, beware if you are.
if (typeof window !== "undefined") {
    const { protocol, hostname, port } = new URL(import.meta.url);
    const baseUrl = `${protocol}//${hostname}${port ? `:${port}` : ""}`;
    const csvUrl = `${baseUrl}/assets/map.csv`;

    // Get the file from URL
    const csv$ = fromFetch(csvUrl).pipe(
        switchMap(response => {
            if (response.ok) {
                return response.text();
            } else {
                throw new Error(`Fetch error: ${response.status}`);
            }
        }),
        catchError(err => {
            console.error("Error fetching the CSV file:", err);
            throw err;
        }),
    );

    // Observable: wait for first user click
    const click$ = fromEvent(document.body, "mousedown").pipe(take(1));

    csv$.pipe(
        switchMap(contents =>
            // On click - start the game
            click$.pipe(switchMap(() => state$(contents))),
        ),
    ).subscribe(render());
}
