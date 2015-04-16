/*
 * grunt-mutation-testing
 *
 *
 * Copyright (c) 2014 Marco Stahl
 * Licensed under the MIT license.
 *
 * TODO (Martin Koster): split up this file and refactor to effect better separation of concerns. That should also improve legibility
 */

'use strict';
var esprima = require('esprima');
var fs = require('fs');
var exec = require('sync-exec');
var path = require('path');
var Q = require('q');
var _ = require('lodash');

var Mutator = require('../lib/Mutator');
var TestStatus = require('../lib/TestStatus');
var mutationTestingKarma = require('./mutation-testing-karma');
var mutationTestingMocha = require('./mutation-testing-mocha');
var OptionUtils = require('../utils/OptionUtils');

var IOUtils = require('../utils/IOUtils');
var reportGenerator = require('../lib/reporting/ReportGenerator');
var survivingMutations = [];

function ensureRegExpArray(value) {
    var array = _.isArray(value) ? value : [value];
    return array.map(function (stringOrRegExp) {
        return _.isString(stringOrRegExp) ? new RegExp('^' + stringOrRegExp + '$') : stringOrRegExp;
    });
}

function canBeIgnored(opts, src, mutation) {
    if (!opts.ignore) {
        return false;
    }
    var ignorePatterns = ensureRegExpArray(opts.ignore);
    var affectedSrcPart = src.substring(mutation.begin, mutation.end);
    return _.any(ignorePatterns, function (ignorePattern) {
        return ignorePattern.test(affectedSrcPart);
    });
}

function canBeDiscarded(opts, mutation) {
    if (!opts.discardReplacements) {
        return false;
    }
    var discardPatterns = ensureRegExpArray(opts.discardReplacements);
    return _.any(discardPatterns, function (discardPattern) {
        return discardPattern.test(mutation.replacement);
    });
}

function createStats() {
    return {
        all: 0,
        ignored: 0,
        untested: 0,
        survived: 0
    };
}

function addStats(stats1, stats2) {
    return _.mapValues(stats1, function (value, key) {
        return value + stats2[key];
    });
}

function createStatsMessage(stats) {
    var ignoredMessage = stats.ignored ? ' ' + stats.ignored + ' mutations were ignored.' : '';
    var allUnIgnored = stats.all - stats.ignored;
    var testedMutations = allUnIgnored - stats.untested - stats.survived;
    var percentTested = Math.floor((testedMutations / allUnIgnored) * 100);
    return testedMutations +
        ' of ' + allUnIgnored + ' unignored mutations are tested (' + percentTested + '%).' + ignoredMessage;
}

function truncateReplacement(opts, replacementArg) {
    var maxLength = opts.maxReportedMutationLength !== undefined ? opts.maxReportedMutationLength : 80;
    var replacement = replacementArg.replace(/\s+/g, ' ');
    if (maxLength > 0 && replacement.length > maxLength) {
        return replacement.slice(0, maxLength / 2) + ' ... ' + replacement.slice(-maxLength / 2);
    }
    return replacement;
}

function createMutationFileMessage(opts, srcFile) {
    var normalizedBasePath = IOUtils.normalizeWindowsPath(opts.basePath),
        normalizedSrcFile = IOUtils.normalizeWindowsPath(srcFile);
    return _.last(normalizedSrcFile.split(normalizedBasePath));
}

function createMutationLogMessage(opts, srcFilePath, mutation, src, testStatus) {
    var srcFileName = createMutationFileMessage(opts, srcFilePath),
        currentMutationPosition = srcFileName + ':' + mutation.line + ':' + (mutation.col + 1),
        mutatedCode = src.substr(mutation.begin, mutation.end - mutation.begin),
        message = currentMutationPosition + (
            mutation.replacement ?
            ' Replaced ' + truncateReplacement(opts, mutatedCode) + ' with ' + truncateReplacement(opts, mutation.replacement) + ' -> ' + testStatus :
            ' Removed ' + truncateReplacement(opts, mutatedCode) + ' -> ' + testStatus
            );

    return {
        mutation: mutation,
        survived: testStatus === TestStatus.SURVIVED,
        message: message
    };
}

function createTestsFailWithoutMutationsLogMessage(opts, srcFilePath) {
    var srcFileName = createMutationFileMessage(opts, srcFilePath);
    return srcFileName + ' tests fail without mutations';
}

function createNotTestedBecauseInsideUntestedMutationLogMessage(opts, srcFilePath, mutation) {
    var srcFileName = createMutationFileMessage(opts, srcFilePath);
    var currentMutationPosition = srcFileName + ':' + mutation.line + ':' + (mutation.col + 1);
    return currentMutationPosition + ' is inside a surviving mutation';
}

function isInsideNotFailingMutation(innerMutation) {
    return _.indexOf(survivingMutations, innerMutation.parentMutationId) > -1;
}

/**
 * @param {string} srcFilename
 * @param {function} runTests
 * @param {function} logMutation
 * @param {function} log the logger
 * @param {object} opts the config options
 */
function mutationTestFile(srcFilename, runTests, logMutation, log, opts) {
    var src = fs.readFileSync(path.resolve(srcFilename), 'UTF8');
    var mutator = new Mutator(src);
    var mutations = mutator.collectMutations(opts.excludeMutations);
    var mutationPromise = new Q({});

    var stats = createStats();
    var fileMutationResult = {
        stats: stats,
        src: src,
        fileName: createMutationFileMessage(opts, srcFilename),
        mutationResults: []
    };

    log('\nMutating file ' + srcFilename + '\n');

    mutations.forEach(function (mutation) {
        stats.all += 1;
        if (canBeDiscarded(opts, mutation)) {
            return;
        }
        if (canBeIgnored(opts, src, mutation)) {
            stats.ignored += 1;
            return;
        }
        var perc = Math.round((stats.all / mutations.length) * 100);
        mutationPromise = mutationPromise.then(function () {
            log('Line ' + mutation.line + ' (' + perc + '%), ');
            if (opts.dontTestInsideNotFailingMutations && isInsideNotFailingMutation(mutation)) {
                stats.untested += 1;
                logMutation(createNotTestedBecauseInsideUntestedMutationLogMessage(opts, srcFilename, mutation));
                return;
            }
            fs.writeFileSync(srcFilename, mutator.applyMutation(mutation));
            return runTests().then(function (testStatus) {
				var mutationResult = createMutationLogMessage(opts, srcFilename, mutation, src, testStatus);
                fileMutationResult.mutationResults.push(mutationResult);
                if (testStatus === TestStatus.SURVIVED) {
                    stats.survived += 1;
                    logMutation(mutationResult.message);
                    survivingMutations.push(mutation.mutationId);
                } else if (testStatus === TestStatus.FATAL) {
                    console.error('A fatal exception occurred after mutating file' + srcFilename);
                    console.error(mutationResult.message);
                    process.exit(1);
                }
            });
        });
    });

    mutationPromise = mutationPromise.then(function () {
        return {stats: stats, fileMutationResult: fileMutationResult};
    });

    return mutationPromise.fin(function () {
        console.log('\nRestore ', srcFilename);
        fs.writeFileSync(srcFilename, src);
    });
}


function mutationTest(grunt, task, opts) {
    var done = task.async(),
        mutationTestPromise = new Q(),
        totalResults = [];

    function logToMutationReport(fileDest, msg) {
        if (fileDest === 'LOG') {
            grunt.log.writeln('\n' + msg);
            return;
        }
        if (!grunt.file.exists(fileDest)) {
            grunt.file.write(fileDest, '');
        }
        fs.appendFileSync(fileDest, msg + '\n');
    }

    function createMutationHtmlReport(results) {
        if(opts.reporters.html) {
            reportGenerator.generate(opts.reporters.html, results);
        }
    }

    function runTests() {
        var deferred = Q.defer();
        if (typeof opts.test === 'string') {
            var execResult = exec(opts.test);
            deferred.resolve(execResult.status);
        } else {
            opts.test(function (status) {
                deferred.resolve(status);
            });
        }
        return deferred.promise;
    }

    opts.before(function () {
        var statsSummary = createStats(),
            logFile = 'LOG',
            logMutationToFileDest;

        if(opts.reporters.text) {
            logFile = path.join(opts.reporters.text.dir, opts.reporters.text.file || 'grunt-mutation-testing.txt');
        }
        logMutationToFileDest = _.partial(logToMutationReport, logFile);

        opts.mutate.forEach(function(file) {
            // Execute beforeEach
            mutationTestPromise = mutationTestPromise.then(function() {
                var deferred = Q.defer();

                opts.currentFile = file;
                opts.beforeEach(function(ok) {
                    deferred.resolve(ok);
                });

                return deferred.promise;
            });

            // Execute test
            mutationTestPromise = mutationTestPromise.then(function() {
                // Run tests first to see if they pass without mutations
                return runTests().then(function(testOk) {
                    function log(msg) {
                        grunt.log.write(msg);
                    }

                    if(testOk) {
                        if(!grunt.file.exists(file)) {
                            grunt.log.warn('Source file "' + file + '" not found.');
                            return false;
                        }

                        return mutationTestFile(path.resolve(file), runTests, logMutationToFileDest, log, opts).then(function(opts) {
                            statsSummary = addStats(statsSummary, opts.stats);
                            totalResults.push(opts.fileMutationResult);
                        });
                    } else {
                        log('\nTests fail without mutations for file ' + path.resolve(file) + '\n');
                        logMutationToFileDest(createTestsFailWithoutMutationsLogMessage(opts, file));
                    }
                });
            });

            // Execute afterEach
            mutationTestPromise = mutationTestPromise.then(function() {
                var deferred = Q.defer();
                opts.afterEach(function() {
                    deferred.resolve();
                });
                return deferred.promise;
            });
        });

        mutationTestPromise = mutationTestPromise.then(function() {
            if(statsSummary.all > 0) {
                logMutationToFileDest(createStatsMessage(statsSummary));
            }
        });

        mutationTestPromise.then(function() {
            var dfd = Q.defer();

            createMutationHtmlReport(totalResults);
            opts.after(function () {
                dfd.resolve();
            });

            return dfd.promise;
        });

        mutationTestPromise.done(done);
    });
}

module.exports = function (grunt) {
    grunt.registerMultiTask('mutationTest', 'Test your tests by mutating the code.', function() {
        var opts = OptionUtils.getOptions(grunt, this);
        mutationTestingKarma.init(grunt, opts);
        mutationTestingMocha.init(grunt, opts);
        mutationTest(grunt, this, opts);
    });
};
