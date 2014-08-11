'use strict';

describe('A service using $xResource', function() {
  var Customer;
  beforeEach(function() {
    module('exResource');
    inject(function($injector) {
      Customer = $injector.get('$xResource')('/customers/:id', {id: '@id'});
    });
  });

  describe('calling action query', function() {
    var resource;
    beforeEach(function() {
      resource = Customer.query();
    });

    it('should return a resource with cache metadata', function() {
      expect(resource).toBeDefined();
      expect(resource.$promise).toBeDefined();
      expect(resource.$cache).toBeDefined();
      expect(resource.$cache.stale).toBe(true);
    });
  });

  describe('delete a Customer', function() {
    var resource;
    beforeEach(function() {
      resource = Customer.delete({id: 1});
    });

    it('should return a resource without cache metadata', function() {
      expect(resource).toBeDefined();
      expect(resource.$promise).toBeDefined();
      expect(resource.$cache).toBeUndefined();
    });
  });
});