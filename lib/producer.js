const _ = require("lodash");
const uuid = require("uuid");
const path = require("path");
const fs = require("fs-extra");
const Context = require("./utils/context");
const constants = require("./utils/constants");
const {
  getIntelligencesAPI,
  updateIntelligencesAPI,
} = require("./apis/tasks");
const { sendIntelligencesToSOI } = require("./apis/retailers");
const { getProducerAPI } = require("./apis/producers");
const { serviceCrawler } = require("./workers/serviceWorker");
const { joinURL } = require("./utils");
const HTTPError = require("./utils/HTTPError");

const DEFAULT_CONFIGS = {
  BITSKY_BASE_URL: undefined,
  BITSKY_SECURITY_KEY: undefined,
  GLOBAL_ID: undefined,
};

class Producer {
  constructor(context, configs) {
    //================================================================================
    // Producer configurations
    this.__type = constants.SERVICE_AGENT_TYPE; // default type is "service producer"
    this.__worker = serviceCrawler; // default worker for this producer is service crawler
    this.__producerError = null; // error happened when get producer
    // how many job ran
    this.__ranJobNumber = 0;
    this.__currentProducerConfig = undefined;
    this.__watchIntelligencesIntervalHandler = undefined;
    this.__watchProducerIntervalHandler = undefined;
    this.__runningJob = {
      // current running job
      totalIntelligences: [], // total intelligences that need to collect
      collectedIntelligencesDict: {}, // collected intelligences
      collectedIntelligencesNumber: 0,
      jobId: undefined,
      startTime: 0,
      jobTimeout: false,
      endingCollectIntelligencesJob: false,
      jobTimeoutHandler: undefined,
      lockJob: false,
    };
    this.__manuallySetConfigs = {
      BITSKY_BASE_URL: undefined,
      BITSKY_SECURITY_KEY: undefined,
      GLOBAL_ID: undefined,
    };
    if (context instanceof Context) {
      this.context = context;
    } else {
      this.context = new Context();
    }

    this.context.producer = this;
    this.setConfigs(configs);
  }

  getConfigs() {
    // get configs from env
    let configs = {
      BITSKY_BASE_URL: process.env.BITSKY_BASE_URL,
      BITSKY_SECURITY_KEY: process.env.BITSKY_SECURITY_KEY,
      PRODUCER_SERIAL_ID: process.env.PRODUCER_SERIAL_ID,
      GLOBAL_ID: process.env.GLOBAL_ID,
    };

    // 1. manually set configs' priority is high than env variables
    // 2. get latest env variables
    configs = _.merge({}, DEFAULT_CONFIGS, configs, this.__manuallySetConfigs);

    if (!configs.BITSKY_BASE_URL) {
      console.warn(
        "You must set `BITSKY_BASE_URL` by `process.env.BITSKY_BASE_URL`. "
      );
    }

    if (!configs.GLOBAL_ID) {
      console.warn("You must set `GLOBAL_ID` by `process.env.GLOBAL_ID` ");
    }

    if (!configs.PRODUCER_SERIAL_ID) {
      // if PRODUCER_SERIAL_ID doesn't exit then need to init
      try {
        const baseservice = _.get(this, "context.baseservice");
        let publicFolder;
        if (baseservice) {
          publicFolder = baseservice.getDefaultPublic();
        }

        if (!publicFolder) {
          publicFolder = path.join(__dirname, "./public");
        }
        const preferencesPath = path.join(publicFolder, "preferences.json");
        fs.ensureFileSync(preferencesPath);
        const preferencesJSON = fs.readJSONSync(preferencesPath) || {};
        if (!preferencesJSON.PRODUCER_SERIAL_ID) {
          preferencesJSON.PRODUCER_SERIAL_ID = uuid.v4();
          fs.writeJsonSync(preferencesPath, preferencesJSON);
        }
        configs.PRODUCER_SERIAL_ID = preferencesJSON.PRODUCER_SERIAL_ID;
      } catch (err) {
        const logger = _.get(this, "context.logger") || console;
        logger.error(`Init producer PRODUCER_SERIAL_ID fail. Error: ${err.message}`, {
          function: "getConfigs",
          error: err,
        });

        // create an in memorry PRODUCER_SERIAL_ID
        process.env.PRODUCER_SERIAL_ID = uuid.v4();
        configs.PRODUCER_SERIAL_ID = process.env.PRODUCER_SERIAL_ID;
      }
    }

    return configs;
  }

  setConfigs(configs) {
    if (configs instanceof Object) {
      this.__manuallySetConfigs = configs;
    }
  }

  /**
   * Get an Producer's configuration
   * @returns {object|undefined} - Producer Configuration, **undefined** means cannot get any configuration
   */
  async getProducerConfiguration() {
    const logger = _.get(this, "context.logger") || console;
    logger.debug("getProducerConfiguration()");
    const configs = this.getConfigs();
    try {
      // Get stored producer configuration information, normally need to get DIA Base URL and Producer Global Id
      logger.debug("getProducerConfiguration->configs: ", {
        configs,
      });
      // If Producer Global ID or DIA Base URL is empty, then return empty producer configuration
      if (!configs.BITSKY_BASE_URL || !configs.GLOBAL_ID) {
        logger.debug(
          `Producer GlobalId or BitSky BaseURL is empty, return Producer Config: ${configs}`
        );
        this.__producerError = {
          status: 400,
          message: "GLOBAL_ID and BITSKY_BASE_URL is required",
        };
        return undefined;
      } else {
        // Get Producer Configuration from server side
        logger.debug(
          `Get Producer Config from server. BitSky MetadData URL: ${configs.BITSKY_BASE_URL}, Producer Global ID: ${configs.GLOBAL_ID}, Security Key: ${configs.BITSKY_SECURITY_KEY}`
        );
        let producer = await getProducerAPI(
          configs.BITSKY_BASE_URL,
          configs.GLOBAL_ID,
          this.type(),
          configs.BITSKY_SECURITY_KEY,
          this.context
        );
        this.__producerError = null;
        producer = _.merge({}, constants.DEFAULT_AGENT_CONFIGURATION, producer);
        logger.debug("getProducerConfiguration->producer: ", { producer });
        return producer;
      }
    } catch (err) {
      logger.error(`Fail getProducerConfiguration. Error: ${err.message}`, {
        error: err,
      });

      if (err && err.status) {
        console.log("Status: ", err.status);
        console.log("Code: ", err.code);
        this.__producerError = {
          error: true,
          status: err.status,
          code: err.code,
        };
        // if http status is 404, means this producer doesn't be registered
        if (err.status === 404) {
          this.__producerError.message = `Cannot find any producer by ${configs.GLOBAL_ID}. Please check your GLOBAL_ID`;
        } else if (err.status === 401) {
          this.__producerError.message = `Please pass correct BITSKY_SECURITY_KEY. ${configs.BITSKY_SECURITY_KEY} is invalid`;
        } else if (err.status >= 500) {
          this.__producerError.message = `Internal server error`;
        } else if (err.status === 403) {
          this.__producerError.message = `The producer you want connect to was already connected by other producer instance. You need to disconnect it before you can connect or change another producer to connect`;
        } else if (err.status >= 400 && err.code === "00144000002") {
          this.__producerError.message = `Please set PRODUCER_SERIAL_ID, this is required`;
        } else if (err.status >= 400 && err.code === "00144000004") {
          this.__producerError.message = `The producer's type you are trying to connect isn't ${this.type()}, please change Producer Global ID which its type is ${this.type()}`;
        } else if (err.status >= 400) {
          this.__producerError.message = `Please check GLOBAL ID, PRODUCER_SERIAL_ID or BITSKY_SECURITY_KEY, some fileds isn't correct`;
        } else {
          this.__producerError.message = `Internal server error`;
        }
      } else {
        this.__producerError.message = `Internal server error`;
      }
      return undefined;
    }
  }

  /**
   * compare current Producer Config with remote producer config
   * @param {object} config - Producer config get from Remote
   */
  async compareProducerConfiguration() {
    const logger = _.get(this, "context.logger") || console;
    logger.debug("compareProducerConfiguration");
    try {
      // Get Producer Config from remote server
      let config = await this.getProducerConfiguration();
      // Get current Producer Config

      logger.info(
        `From remote: globalId ${_.get(config, "globalId")}, version: ${_.get(
          config,
          "system.version"
        )} `
      );
      logger.info(
        `From local: globalId ${_.get(
          this.__currentProducerConfig,
          "globalId"
        )}, version: ${_.get(this.__currentProducerConfig, "system.version")} `
      );

      // compare producer global id and version, if same then don't need to initJob, otherwise means producer was changed, then need to re-initJob
      // 1. globalId changed means change producer
      // 2. if globalId is same, then if version isn't same, then means this producer was changed
      // if it is first time, then currentProducerConfig should be undefined
      if (
        _.get(config, "globalId") !==
          _.get(this.__currentProducerConfig, "globalId") ||
        _.get(config, "system.version") !==
          _.get(this.__currentProducerConfig, "system.version")
      ) {
        logger.debug("Producer Configuration was changed, need to re-watchJob");
        const configs = this.getConfigs();
        this.__currentProducerConfig = config;
        // if type or globalId doesn't exist, then means get producer config fail
        // if get producer config, but type isn't same, then also fail
        if (
          !configs.BITSKY_BASE_URL ||
          !_.get(config, "type") ||
          !_.get(config, "globalId") ||
          _.toUpper(_.get(config, "type")) !== _.toUpper(this.__type) ||
          _.toUpper(_.get(config, "system.state")) !=
            _.toUpper(constants.AGENT_STATE.active)
        ) {
          logger.warn(
            "Didn't get producer config from server or get producer type is different with current producer type or current producer isn't active state"
          );
          await this.endPollingGetIntelligences();
        } else {
          await this.startPollingGetIntelligences();
        }
      } else {
        logger.info(
          `Producer Configuration is same, don't need to re-watchJob. Producer Global Id: ${_.get(
            this.__currentProducerConfig,
            "globalId"
          )}`,
          { jobId: _.get(this.__runningJob, "jobId") }
        );
      }
    } catch (err) {
      logger.error(
        `compareProducerConfiguration error: ${_.get(err, "message")}`,
        {
          jobId: _.get(this.__runningJob, "jobId"),
          error: err,
        }
      );
    }
  }

  /**
   * Check whether need to collect intelligences
   *
   * @returns {boolean}
   */
  async startPollingGetIntelligences() {
    const logger = _.get(this, "context.logger") || console;
    logger.debug("startPollingGetIntelligences()");
    // logger
    try {
      // Before start, make sure we already stop previous job;
      await this.endPollingGetIntelligences();
      // Producer configuration
      let producerConfigs = this.__currentProducerConfig;
      // How frequently check whether need to collect intelligence
      // TODO: whether this value allow user to configure???, maybe not
      // Comment: 07/31/2019, to avoid possible performance issue, don't allow user to change the polling interval value
      let pollingValue =
        (producerConfigs.pollingInterval ||
          constants.DEFAULT_AGENT_CONFIGURATION.pollingInterval) * 1000;
      // Comment: 04/17/2020, since we don't provide cloud version to customer, so let customer to decide how frequently they want producer to polling
      // let pollingValue = constants.DEFAULT_AGENT_CONFIGURATION.pollingInterval * 1000;
      logger.debug(`polling every ${pollingValue} ms`);
      clearInterval(this.__watchIntelligencesIntervalHandler);
      // interval to check new intelligences
      this.__watchIntelligencesIntervalHandler = setInterval(async () => {
        logger.debug("startPollingGetIntelligences -> interval");
        if (!this.__runningJob.jobId && !this.__runningJob.lockJob) {
          logger.info("No running job!, startCollectIntelligencesJob");
          // don't have a in-progress job
          await this.startCollectIntelligencesJob();
        } else {
          logger.info(
            `waiting job id ${_.get(this.__runningJob, "jobId")} finish ......`,
            { jobId: _.get(this.__runningJob, "jobId") }
          );
          // if (
          //   Date.now() - runningJob.startTime >
          //   constants.COLLECT_JOB_TIMEOUT
          // ) {
          //   logger.warn(
          //     `Currnet running job is timeout. jobId: ${runningJob.jobId}, startTime: ${runningJob.startTime}`
          //   );
          //   await this.endCollectIntelligencesJob();
          // } else {
          //   logger.debug("Continue waiting current job to finish");
          // }
        }
      }, pollingValue);
      //logger.debug('startWatchNewJob -> _intervalHandlerToGetIntelligences: ', _intervalHandlerToGetIntelligences);
    } catch (err) {
      logger.error(`startPollingGetIntelligences fail. Error: ${err.message}`, {
        error: err,
      });
      // await endPollingGetIntelligences();
    }
  }

  /**
   * Stop polling to get intelligences
   */
  async endPollingGetIntelligences() {
    const logger = _.get(this, "context.logger") || console;
    try {
      logger.debug("endPollingGetIntelligences()");
      // Clear intervalHandler
      clearInterval(this.__watchIntelligencesIntervalHandler);
      this.__watchIntelligencesIntervalHandler = null;
      // Also need to endCollectIntelligencesJob
      await this.endCollectIntelligencesJob();
      logger.info(
        `Successfully endPollingGetIntelligences, Producer Global ID: ${_.get(
          this.__currentProducerConfig,
          "globalId"
        )}`,
        { jobId: _.get(this.__runningJob, "jobId") }
      );
    } catch (err) {
      logger.error(
        `Fail endPollingGetIntelligences, Producer Global ID: ${_.get(
          this.__currentProducerConfig,
          "globalId"
        )}, Error: ${_.get(err, "message")}`,
        { error: err }
      );
    }
  }

  /**
   * Update intelligence's state and endAt time
   * @param {object} intelligence - intellignece you want to update
   * @param {string} state - what is state you want to set. ["FAILED", "FINISHED"]
   * @param {*} reason - if state is "FAILED", then the reason why it is fail. It will transfer reason to string
   */
  setIntelligenceState(intelligence, state, reason) {
    _.set(intelligence, "system.state", _.toUpper(state));
    if (_.get(intelligence, "system.producer.endedAt")) {
      // if producer didn't set endedAt, then set to current timestamp
      _.set(intelligence, "system.producer.endedAt", Date.now());
    }
    if (reason) {
      let reasonStr = "";
      if (reason instanceof Error) {
        reasonStr = reason.message;
      } else if (typeof reason === "object") {
        reasonStr = JSON.stringify(reason);
      } else {
        reasonStr = _.toString(reason);
      }
      _.set(intelligence, "system.failuresReason", reasonStr);
    }

    return intelligence;
  }

  /**
   * Start collect intelligences
   * @param {array} intelligences - intelligences that need to be collected
   */
  async startCollectIntelligencesJob() {
    const logger = _.get(this, "context.logger") || console;
    try {
      // if this.__runningJob.jobId isn't undefined, then means previous job isn't finish
      if (
        this.__runningJob.jobId ||
        this.__runningJob.lockJob ||
        this.__runningJob.endingCollectIntelligencesJob
      ) {
        logger.info(
          `Call startCollectIntelligences but previous job ${_.get(
            this.__runningJob,
            "jobId"
          )} is still running`,
          { jobId: this.__runningJob.jobId }
        );
        return true;
      }

      // start collectIntelligencesJob lockJob need to excute ASAP
      this.initRunningJob();
      logger.info(`<<<<<<Start job: ${this.__runningJob.jobId}`, {
        jobId: this.__runningJob.jobId,
      });
      const configs = this.getConfigs();
      let intelligences = await getIntelligencesAPI(
        configs.BITSKY_BASE_URL,
        configs.GLOBAL_ID,
        configs.BITSKY_SECURITY_KEY,
        this.context
      );
      logger.info(`intelligences: ${intelligences.length}`, {
        jobId: this.__runningJob.jobId,
      });
      if (intelligences && !intelligences.length) {
        // no intelligences need to be collected
        // don't need to crawl, resetRunningJob
        logger.info(
          `>>>>>> End job: ${this.__runningJob.jobId} because not intelligences`,
          { jobId: this.__runningJob.jobId }
        );
        await this.__worker({
          intelligences: [],
          jobId: this.__runningJob.jobId,
          producerConfig: this.__currentProducerConfig,
          context: this.context,
        });
        this.resetRunningJob();
        return true;
      }
      this.__ranJobNumber++;
      logger.info(`[[[[[[ Job Number: ${this.__ranJobNumber} ]]]]]]`, {
        jobId: this.__runningJob.jobId,
      });

      // set total intelligences that need to collect
      this.__runningJob.totalIntelligences = intelligences;

      // Make sure you set worker before
      let promises = await this.__worker({
        intelligences,
        jobId: this.__runningJob.jobId,
        producerConfig: this.__currentProducerConfig,
        context: this.context,
      });
      // whether currently job timeout
      clearTimeout(this.__runningJob.jobTimeoutHandler);
      this.__runningJob.jobTimeoutHandler = setTimeout(() => {
        // job timeout
        this.__runningJob.jobTimeout = true;
        // when timeout, all intelligences will timeout
        logger.info(
          `job id ${this.__runningJob.jobId} timeout, startTime is ${this.__runningJob.startTime}`,
          {
            jobId: this.__runningJob.jobId,
          }
        );
        this.__runningJob.jobTimeoutHandler = undefined;
        // set all intelligences to timeout
        this.__runningJob.totalIntelligences.forEach((intelligence) => {
          // set intelligence to "FAILED"
          this.__runningJob.collectedIntelligencesDict[
            intelligence.globalId
          ] = this.setIntelligenceState(
            intelligence,
            "TIMEOUT",
            "collect intelligences timeout"
          );
          // increase collected intelligences
          this.__runningJob.collectedIntelligencesNumber++;
        });
        this.endCollectIntelligencesJob();

        // TODO: COLLECT_JOB_TIMEOUT should be configurable in producer
      }, constants.COLLECT_JOB_TIMEOUT);

      await Promise.allSettled(promises)
        .then((results) => {
          if (this.__runningJob.jobTimeout) {
            // currently job is timeout, don't need to continue
            return;
          }
          logger.info(`${this.__runningJob.jobId} collect data successful.`, {
            jobId: this.__runningJob.jobId,
          });
          clearTimeout(this.__runningJob.jobTimeoutHandler);
          this.__runningJob.jobTimeoutHandler = undefined;

          // Update coolected intelligences to runningJob
          results.forEach((result) => {
            if (
              _.toLower(result.status) === "fulfilled" &&
              _.get(result, "value.globalId")
            ) {
              let intelligence = result.value;
              // means successful and return intelligence
              this.__runningJob.collectedIntelligencesDict[
                intelligence.globalId
              ] = this.setIntelligenceState(intelligence, "FINISHED");
              // increase collected intelligences
              this.__runningJob.collectedIntelligencesNumber++;
            } else if (
              _.toLower(result.status) === "rejected" &&
              _.get(result, "reason.globalId")
            ) {
              let intelligence = result.reason;
              // 2. result.status is 'rejected', then collect intelligence fail
              this.__runningJob.collectedIntelligencesDict[
                intelligence.globalId
              ] = this.setIntelligenceState(intelligence, "FAILED");
              // increase collected intelligences
              this.__runningJob.collectedIntelligencesNumber++;
            } else {
              // if didn't return globalId, then skip it
              logger.debug(
                "Skip this intelligence. You need to resolve(intelligence) or reject(intelligen), return the intelligence back"
              );
            }
          });
          this.endCollectIntelligencesJob();
        })
        .catch((err) => {
          if (this.__runningJob.jobTimeout) {
            return;
          }
          logger.error(
            `${this.__runningJob.jobId} collect data fail. Error: ${err.message}`,
            { jobId: this.__runningJob.jobId, error: err }
          );
          clearTimeout(this.__runningJob.jobTimeoutHandler);
          this.__runningJob.jobTimeoutHandler = undefined;
          this.endCollectIntelligencesJob();
        });
    } catch (err) {
      logger.error(
        `Start job fail: ${this.__runningJob.jobId}, intelligences: ${
          this.__runningJob.totalIntelligences.length
        }, error: ${_.get(err, "message")}`,
        { jobId: _.get(this.__runningJob, "jobId"), error: err }
      );
      clearTimeout(this.__runningJob.jobTimeoutHandler);
      this.__runningJob.jobTimeoutHandler = undefined;
      this.endCollectIntelligencesJob();
    }
  }

  /**
   * @param {array} intelligences
   */
  async sendToSOIAndDIA(intelligences) {
    const logger = _.get(this, "context.logger") || console;
    // make sure send intelligences to correct SOI, in case, it contains multiple SOIs, so first category them
    logger.debug("[sendToSOIAndDIA][Start]");
    let sois = {};
    const configs = this.getConfigs();
    // Separate SOI based on url and method, so it can send to correct SOI
    // The reason is because it maybe contains multiple SOI's intelligences
    for (let i = 0; i < intelligences.length; i++) {
      let baseUrl = _.get(intelligences[i], "soi.baseURL");
      let method = _.get(intelligences[i], "soi.callback.method");
      let callbackPath = _.get(intelligences[i], "soi.callback.path");
      // any of those intelligences don't exist, then skip this item
      if (!baseUrl || !method || !callbackPath) {
        logger.debug(
          "sendToSOIAndDIA->invalid intelligences, miss baseUrl, method or callbackPath. Skip this item.",
          intelligences[i]
        );
        continue;
      }
      let url = joinURL(callbackPath, baseUrl);
      let key = `${_.toLower(method)}:${_.toLower(url)}`;
      if (!sois[key]) {
        sois[key] = {
          soi: intelligences[i].soi,
          intelligences: [],
        };
      }
      sois[key].intelligences.push(intelligences[i]);
    }

    let promises = [];
    // TODO: need to support parallel send request
    for (let key in sois) {
      if (sois.hasOwnProperty(key)) {
        promises.push(
          new Promise(async (resolve) => {
            try {
              let baseURL = _.get(sois[key], "soi.baseURL");
              let method = _.get(sois[key], "soi.callback.method");
              let callbackPath = _.get(sois[key], "soi.callback.path");

              // TODO: apiKey need to improve, this should be support custom http header
              let apiKey = _.get(sois[key], "soi.apiKey");
              let headers = {};
              if (apiKey) {
                headers[constants.X_SECURITY_KEY_HEADER] = apiKey;
              }

              try {
                await sendIntelligencesToSOI(
                  baseURL,
                  method,
                  callbackPath,
                  headers,
                  intelligences,
                  this.context
                );
              } catch (err) {
                logger.debug(
                  `[sendIntelligencesToSOI][Fail]. Key: ${key}. Error: ${err.message}`,
                  { error: err }
                );
                let intelligences = _.get(sois[key], "intelligences");
                // if send to SOI fail, then change intelligences state to `FAILED`
                intelligences.forEach((intelligence) => {
                  intelligence.system.state = "FAILED";
                  intelligence.system.failuresReason = JSON.stringify(
                    err && err.toJSON()
                  );
                });
              }

              try {
                await updateIntelligencesAPI(
                  configs.BITSKY_BASE_URL,
                  configs.BITSKY_SECURITY_KEY,
                  _.get(sois[key], "intelligences"),
                  this.context
                );
              } catch (err) {
                // if error, also will resolve as successful. The reason is to reduce complex for producer. Normally when updateIntelligencesAPI fail, also cannot get intelligences
                // This maybe caused intelligences are collected multiple time.
                logger.debug(
                  `[updateIntelligencesAPI][Fail], error: ${err.message}`,
                  { error: err }
                );
              }
              resolve([]);
            } catch (err) {
              logger.error(
                `[sendToSOIAndDIA][Fail]. Key: ${key}. Error: ${err.message}`,
                { error: err }
              );
              // the reason of return [] is because, normally producer is automatically start and close, no human monitor it
              // to make sure work flow isn't stopped, so resolve it as []
              resolve([]);
            }
          })
        );
      }
    }

    await Promise.allSettled(promises);
  }

  async endCollectIntelligencesJob() {
    const logger = _.get(this, "context.logger") || console;
    try {
      // if not running job, then don't need to process endCollectIntelligencesJob
      // only process during lockJob time
      if (
        !this.__runningJob.jobId ||
        !this.__runningJob.lockJob ||
        this.__runningJob.endingCollectIntelligencesJob
      ) {
        logger.debug(
          "endCollectIntelligencesJob: no running job or it is in the middle for ending job"
        );
        return;
      }
      this.__runningJob.endingCollectIntelligencesJob = true;
      logger.info(
        `start end job: ${this.__runningJob.jobId}, intelligences: ${this.__runningJob.totalIntelligences.length}`,
        { jobId: _.get(this.__runningJob, "jobId") }
      );
      let temp = [];
      for (let i = 0; i < this.__runningJob.totalIntelligences.length; i++) {
        let tmp = this.__runningJob.totalIntelligences[i];
        let intelligence = this.__runningJob.collectedIntelligencesDict[
          _.get(tmp, "globalId")
        ];
        if (!intelligence) {
          intelligence = tmp;
          // this means timeout, so set it fail.
          intelligence = this.setIntelligenceState(
            intelligence,
            "FAILED",
            "Intelligence failed caused by timeout or you didn't resolve(intelligence) or reject(intelligence) in your producer"
          );
        } else {
          if (!_.get(intelligence, "system.state")) {
            if (_.get(intelligence, "dataset")) {
              // if dataset isn't empty, then sucessfully collect but possible user forget to set system.state
              intelligence = this.setIntelligenceState(
                intelligence,
                "FINISHED"
              );
            } else {
              // else, it should be failed
              intelligence = this.setIntelligenceState(intelligence, "FAILED");
            }
          }
        }

        temp.push(intelligence);
      }

      this.__runningJob.totalIntelligences = temp;
      try {
        await this.sendToSOIAndDIA(this.__runningJob.totalIntelligences);
      } catch (err) {
        logger.error(
          `[endCollectIntelligencesJob->sendToSOIAndDIA] shouldn't fail, something really bad happened! error: ${err.message}`,
          { jobId: _.get(this.__runningJob, "jobId"), error: err }
        );
      }
      logger.info(`Total time: ${Date.now() - this.__runningJob.startTime} ms`);
      logger.info(
        `>>>>>>>>> Successfuly end job ${_.get(this.__runningJob, "jobId")}`,
        {
          jobId: _.get(this.__runningJob, "jobId"),
        }
      );
      this.resetRunningJob();
      this.startCollectIntelligencesJob();
    } catch (err) {
      logger.error(
        `Fail end job: ${this.__runningJob.jobId}, intelligences: ${this.__runningJob.totalIntelligences.length}, error: ${err.message}`,
        { error: err }
      );
      // if cannot successfully end collect intelligence job, then intelligence will keep running state until timeout
      this.resetRunningJob();
      this.startCollectIntelligencesJob();
    }
  }

  resetRuntime() {
    clearInterval(this.__watchIntelligencesIntervalHandler);
    clearInterval(this.__watchProducerIntervalHandler);
    this.__ranJobNumber = 0;
    this.__currentProducerConfig = undefined;
    this.__watchIntelligencesIntervalHandler = undefined;
    this.__watchProducerIntervalHandler = undefined;
    this.resetRunningJob();
    return this;
  }

  resetRunningJob() {
    clearTimeout(this.__runningJob.jobTimeoutHandler);
    this.__runningJob.totalIntelligences = [];
    this.__runningJob.collectedIntelligencesDict = {};
    this.__runningJob.collectedIntelligencesNumber = 0;
    this.__runningJob.jobId = undefined;
    this.__runningJob.startTime = 0;
    this.__runningJob.jobTimeout = false;
    this.__runningJob.endingCollectIntelligencesJob = false;
    this.__runningJob.jobTimeoutHandler = undefined;
    this.__runningJob.lockJob = false;
    return this;
  }

  initRunningJob(intelligences) {
    this.resetRunningJob();
    this.__runningJob.totalIntelligences = intelligences || [];
    this.__runningJob.jobId = uuid.v4();
    this.__runningJob.startTime = Date.now();
    this.__runningJob.lockJob = true;
    return this;
  }

  /**
   * Watch whether producer configuration changed remote
   */
  async start() {
    const logger = _.get(this, "context.logger") || console;
    logger.debug("start");
    // Clear previous interval handler
    this.resetRuntime();
    if (!this.__type) {
      this.__type = constants.SERVICE_AGENT_TYPE; // default type is "service producer"
    }
    if (!this.__worker) {
      this.__worker = serviceCrawler; // default worker for this producer is service crawler
    }
    this.__watchProducerIntervalHandler = setInterval(() => {
      // compare producer configuration with server side, if need, then initJob
      this.compareProducerConfiguration();
    }, constants.POLLING_INTERVAL_WATCH_AGENT);
  }

  /**
   * Stop this producer
   */
  async stop() {
    const logger = _.get(this, "context.logger") || console;
    try {
      this.resetRuntime();
    } catch (err) {
      logger.error(`Stop producer fail. Error: ${err.message}`, {
        error: err,
      });
    }
  }

  /**
   * Get or Set Producer Type
   * @param {string|undefined|null} type - producer type string
   *
   * @throws {Error} if type isn't a none-empty string, throw error
   * @returns {Producer}
   */
  type(type) {
    if (!type) {
      return this.__type;
    }

    // type must be a string
    if (!(type instanceof String) && !type) {
      throw new Error(`${type} isn't valid, you must pass a not empty string`);
    }
    this.__type = type;

    return this;
  }

  /**
   * Get or Set worker used for this producer. Worker response for really run each job
   * Default worker is `serviceCrawler`
   *
   * @param {Function|undefined} worker - worker must be a function
   *
   * @throws {Error} if worker isn't a function, throw error
   * @returns {Producer}
   */
  worker(worker) {
    if (!worker) {
      return this.__worker;
    }

    if (!(worker instanceof Function)) {
      throw new Error(
        `${worker} isn't valid, you must pass a not empty function`
      );
    }
    this.__worker = worker;

    return this;
  }

  /**
   * Get currently producer configuration
   */
  producerConfiguration() {
    return this.__currentProducerConfig;
  }

  producerError() {
    return this.__producerError;
  }

  jobId() {
    return _.get(this.__runningJob, "jobId");
  }
}

module.exports = Producer;